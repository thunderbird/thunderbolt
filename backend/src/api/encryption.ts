/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { type Auth, createAuthMacro } from '@/auth/elysia-plugin'

import {
  bridgeDeviceId,
  countActiveDevices,
  getDeviceById,
  linkSessionToDevice,
  registerDevice,
  registerBridgeDevice,
  deleteRevokedBridgeDevice,
  denyDevice,
  markDeviceTrusted,
  setDeviceNodeId,
  getTrustedNodeIds,
  listEnvelopeCapableDeviceIds,
  listEnvelopeCapableDevices,
  getEnvelopeByDeviceId,
  hasEnvelopesForUser,
  upsertEnvelope,
  getEncryptionMetadata,
  insertEncryptionMetadataIfNotExists,
  replaceEncryptionMetadata,
  flipSchemeToV2,
  bumpKeyVersion,
  setPrimaryKeyId,
  getWrappedKey,
  listWrappedKeys,
  insertWrappedKey,
  updateWrappedKey,
  issueChallengeNonce,
  consumeChallengeNonce,
  revokeDeviceSessions,
  upsertOrgEnvelope,
} from '@/dal'
import type { Settings } from '@/config/settings'
import type { db as DbType } from '@/db/client'
import { BadRequestError, ForbiddenError } from '@/errors/http-errors'
import { verifyChallengeSignature, verifyPossessionProof } from '@/lib/canary'
import { sealBindNonce } from '@/lib/device-bind'
import {
  type ChallengeOperation,
  type RecoverySlotRequest,
  type WrappedKeyEntry,
  bindOperation,
  challengeNonceTtlMs,
  challengeOperations,
  initialKeyId,
  keyIdPattern,
  legacyKeyId,
} from '@shared/e2ee-types'
import { sql } from 'drizzle-orm'
import { Elysia, t } from 'elysia'

const maxDevicesPerUser = 10

/**
 * Upper bound on keyring rows carried in one request. The keyring grows by one
 * DEK per device revocation and rows are retained forever, so this must sit far
 * above any reachable count: it is the size at which an AK rotation — which must
 * re-wrap the FULL keyring atomically — stops fitting, and a rotation that
 * cannot be expressed is a revocation that cannot be made cryptographic
 * (THU-871).
 *
 * 1000 is ~10x the human ceiling (revocations, not devices) and well inside the
 * tightest transport limit on any deployment path: real entries are ~90 bytes,
 * and the nginx paths in `deploy/` set no `client_max_body_size`, so they cap at
 * the 1 MiB default — room for ~11k entries.
 */
const maxKeyringKeys = 1000

/** Thrown when a concurrent migrator already flipped the account (CAS 1→2 lost) — mapped to 409. */
class SchemeConflictError extends Error {}

/**
 * Thrown when minting a key_id that already exists — mapped to 409 (THU-871).
 *
 * `insertWrappedKey` is `ON CONFLICT DO NOTHING`, so a colliding mint used to be
 * discarded in silence while the route still reported success and moved the
 * primary pointer onto the pre-existing row. Every mint path now asserts that a
 * row was actually inserted, so a conflict aborts its transaction instead.
 */
class KeyConflictError extends Error {}

/** Elysia schema for the shared ChallengeProof request DTO. */
const proofSchema = t.Object({
  signature: t.String({ maxLength: 200 }),
  nonce: t.String({ maxLength: 128 }),
  operation: t.Union(challengeOperations.map((op) => t.Literal(op))),
  deviceId: t.String({ maxLength: 36 }),
})

/**
 * Elysia schema for one wrapped-DEK keyring entry. key_id is a wire-format
 * segment — no ':' allowed.
 *
 * DELIBERATELY NOT tightened to `keyIdPattern` (THU-871). This schema is used by
 * paths that RE-WRAP an existing keyring, and an account may already carry a row
 * whose id predates the grammar or was planted by a malicious server. Rejecting
 * it here would make that account permanently unrotatable — which is exactly the
 * rotation freeze this ticket fixes. The grammar is enforced where a key_id is
 * MINTED (`newPrimaryKey` on /encryption/rotate, and the fixed reserved ids on
 * bootstrap and /encryption/upgrade), so no new id can enter the keyring outside
 * it.
 */
const wrappedKeyEntrySchema = t.Object({
  keyId: t.String({ minLength: 1, maxLength: 64, pattern: '^[^:]+$' }),
  wrappedKey: t.String({ minLength: 1, maxLength: 500 }),
})

/** Elysia schema for the freshly minted primary DEK an AK rotation may carry (THU-871). */
const newPrimaryKeySchema = t.Object({
  keyId: t.String({ minLength: 1, maxLength: 15, pattern: keyIdPattern }),
  wrappedKey: t.String({ minLength: 1, maxLength: 500 }),
})

/** Elysia schema for one AK envelope (`wrappedCK` historically named — it carries the AK). */
const envelopeEntrySchema = t.Object({
  deviceId: t.String({ maxLength: 36 }),
  wrappedCK: t.String({ maxLength: 2200 }),
})

type CallerDeviceResult =
  | { status: 400 | 403 | 404; error: string }
  | { deviceId: string; device: NonNullable<Awaited<ReturnType<typeof getDeviceById>>> }

/** The session fields the caller gate reads. Narrowed so callers pass anything session-shaped. */
type CallerSession = { deviceId?: string | null }

/**
 * Resolve the caller's device: the `X-Device-ID` header must be present AND
 * match the device this session is bound to server-side. The device must belong
 * to the authenticated user and not be revoked. Trust is NOT required here —
 * routes that need a trusted caller check `device.trusted` themselves.
 *
 * THU-873: the header is client-set, so on its own it is a CLAIM, not an
 * identity — any session could name any device and inherit its authority. The
 * authority is `session.deviceId`, which is written only by the sealed-nonce
 * bind handshake (`POST /devices/me/bind`) and by first registration. A session
 * that was never bound fails closed rather than falling back to the header.
 *
 * The match is checked BEFORE the device lookup, so a session cannot probe which
 * device ids exist on its own account either.
 */
const getCallerDevice = async (
  database: typeof DbType,
  userId: string,
  request: Request,
  session: CallerSession,
): Promise<CallerDeviceResult> => {
  const deviceId = request.headers.get('x-device-id')?.trim()
  if (!deviceId) {
    return { status: 400, error: 'X-Device-ID header is required' }
  }
  if (!session.deviceId) {
    return { status: 403, error: 'Session is not bound to a device' }
  }
  if (session.deviceId !== deviceId) {
    return { status: 403, error: 'X-Device-ID does not match the authenticated device' }
  }
  const device = await getDeviceById(database, deviceId)
  if (!device || device.userId !== userId) {
    return { status: 404, error: 'Device not found' }
  }
  if (device.revokedAt != null) {
    return { status: 403, error: 'Device has been revoked' }
  }
  return { deviceId, device }
}

/**
 * Envelope coverage validation (AK rotation + upgrade): the client must supply a
 * new-AK envelope for EXACTLY the set of envelope-capable devices — a missing one
 * locks a device out; an extra one hands the new AK to a revoked/pending device.
 * Throws BadRequestError on any mismatch.
 *
 * "Envelope-capable" (see `listEnvelopeCapableDeviceIds`) means trusted,
 * non-revoked AND holding both hybrid public keys. Requiring coverage for a
 * keyless trusted device (a bridge, or a v1 device that never published v2 keys)
 * would be unsatisfiable — the client cannot wrap an AK without those keys — and
 * would fail every rotation and upgrade on such an account.
 */
const assertEnvelopeCoverage = (capableDeviceIds: string[], envelopes: Array<{ deviceId: string }>): void => {
  const capable = new Set(capableDeviceIds)
  const submitted = new Set(envelopes.map((envelope) => envelope.deviceId))
  if (submitted.size !== envelopes.length) {
    throw new BadRequestError('Duplicate deviceId in envelopes')
  }
  const missing = [...capable].filter((deviceId) => !submitted.has(deviceId))
  if (missing.length > 0) {
    throw new BadRequestError(`envelopes must cover every envelope-capable device — missing: ${missing.join(', ')}`)
  }
  const unknown = [...submitted].filter((deviceId) => !capable.has(deviceId))
  if (unknown.length > 0) {
    throw new BadRequestError(`envelopes contains non-trusted devices: ${unknown.join(', ')}`)
  }
}

/**
 * AK-rotation keyring coverage: the FULL keyring must be re-wrapped under the
 * new AK — re-wrapping a subset strands the missing key_ids under the discarded
 * old AK (permanent data loss). `wrappedKeys` therefore has to match the existing
 * id set EXACTLY, which naturally requires the `"v1"` slot when the account
 * carries one (plan Risk 1). Throws BadRequestError on any mismatch.
 *
 * A rotation may also MINT one new primary DEK (THU-871), and that is the only
 * way a new key_id ever enters an established keyring. It arrives in its own
 * `newPrimaryKey` field rather than as an extra `wrappedKeys` entry, and the
 * strict set equality above is what keeps that door shut: loosening it to "extra
 * ids are fine" would let any caller holding a 'rotate' proof plant arbitrary
 * unopenable rows, which is precisely the capability this ticket removed by
 * deleting `POST /encryption/keys`. So the mint is exactly one id, it must not
 * already exist, and it must not be smuggled into `wrappedKeys` as well.
 *
 * WHAT THIS CANNOT CHECK: key MATERIAL. The server holds no AK, so a submitted
 * `wrappedKeys` entry is an opaque blob — a caller with a valid 'rotate' proof
 * could send freshly minted material for `key_id "0"` and this would accept it.
 * Clients rely on DEK `"0"`'s material being immutable for the life of the
 * account (see `initialKeyId` in `shared/e2ee-types.ts`): each device keeps a
 * local witness under it and refuses any Account Key that cannot reproduce it
 * (THU-869). Giving `"0"` new material therefore makes every established device
 * on that account refuse every future AK, permanently. Preserving it is a
 * client-side obligation of `rewrapKeyring`, enforced nowhere.
 */
const assertRotateKeyCoverage = (
  existingKeyIds: string[],
  wrappedKeys: WrappedKeyEntry[],
  newPrimaryKey?: { keyId: string },
): void => {
  const existing = new Set(existingKeyIds)
  const submitted = new Set(wrappedKeys.map((entry) => entry.keyId))
  if (submitted.size !== wrappedKeys.length) {
    throw new BadRequestError('Duplicate key_id in wrappedKeys')
  }
  const missing = [...existing].filter((keyId) => !submitted.has(keyId))
  if (missing.length > 0) {
    throw new BadRequestError(`wrappedKeys must cover every existing key_id — missing: ${missing.join(', ')}`)
  }
  const unknown = [...submitted].filter((keyId) => !existing.has(keyId))
  if (unknown.length > 0) {
    throw new BadRequestError(`wrappedKeys contains unknown key_ids: ${unknown.join(', ')}`)
  }
  if (!newPrimaryKey) {
    return
  }
  if (existing.has(newPrimaryKey.keyId)) {
    throw new BadRequestError(`newPrimaryKey.keyId '${newPrimaryKey.keyId}' already exists on the keyring`)
  }
  if (submitted.has(newPrimaryKey.keyId)) {
    throw new BadRequestError(`newPrimaryKey.keyId '${newPrimaryKey.keyId}' must not also appear in wrappedKeys`)
  }
}

/**
 * Upgrade keyring coverage: the migrated keyring MUST be EXACTLY the fresh
 * primary DEK `"0"` (post-flip writes need an encrypt-capable primary) plus the
 * absorbed legacy `"v1"` slot (without it, all legacy data is stranded). Throws
 * BadRequestError on anything else (plan §4 Track A upgrade).
 *
 * The exact-set rule (THU-871) is what stops a hostile migrator minting an
 * extra, arbitrary key_id at the moment the account is born — including one
 * crafted to collide with the next allocation and wedge the account's first DEK
 * rotation. Upgrade is a MINT path, so unlike the re-wrap paths it can afford to
 * be strict: the legitimate client submits precisely these two ids.
 */
const assertUpgradeKeyCoverage = (wrappedKeys: WrappedKeyEntry[], primaryKeyId: string): void => {
  const submitted = new Set(wrappedKeys.map((entry) => entry.keyId))
  if (submitted.size !== wrappedKeys.length) {
    throw new BadRequestError('Duplicate key_id in wrappedKeys')
  }
  if (!submitted.has(initialKeyId)) {
    throw new BadRequestError(`upgrade requires a fresh primary key for key_id '${initialKeyId}'`)
  }
  if (!submitted.has(legacyKeyId)) {
    throw new BadRequestError(`upgrade requires the absorbed legacy '${legacyKeyId}' slot`)
  }
  const unexpected = [...submitted].filter((keyId) => keyId !== initialKeyId && keyId !== legacyKeyId)
  if (unexpected.length > 0) {
    throw new BadRequestError(
      `upgrade must mint only '${initialKeyId}' and '${legacyKeyId}' — got: ${unexpected.join(', ')}`,
    )
  }
  // The primary MUST be the freshly-minted encrypt-capable DEK "0" — never the
  // read-only "v1" slot or a key_id absent from the keyring, either of which
  // would break every post-flip write.
  if (primaryKeyId !== initialKeyId) {
    throw new BadRequestError(`upgrade primary_key_id must be '${initialKeyId}'`)
  }
}

/**
 * Recovery-slot coverage (AK rotation + upgrade): the phrase-derived hybrid
 * public keys, the AK wrapped to them, and the attestation over them must arrive
 * together. A partial write would leave the account with a recovery slot no
 * phrase can open — the AK becomes unrecoverable the moment the last device is
 * lost. Submitting public keys that DIFFER from the stored ones is legal: that is
 * an explicit phrase change, gated by the 'rotate' challenge proof.
 *
 * Requiring the attestation here is what lets the client fail closed with no
 * legacy-tolerant branch (THU-865): no v2 recovery slot can be written without
 * one, so a missing attestation means either a pre-column row or tampering —
 * never a legitimate current write.
 *
 * Throws BadRequestError unless all four are present.
 */
const assertRecoveryCoverage = (recovery: RecoverySlotRequest): void => {
  if (
    !recovery.recoveryEcdhPublicKey ||
    !recovery.recoveryMlkemPublicKey ||
    !recovery.recoveryWrappedAK ||
    !recovery.recoveryAttestation
  ) {
    throw new BadRequestError(
      'recoveryEcdhPublicKey, recoveryMlkemPublicKey, recoveryWrappedAK and recoveryAttestation must be supplied together',
    )
  }
}

/**
 * Enforce + persist the org-escrow envelope (THU-804) inside an AK create/change
 * transaction. Every flow that mints a new AK (first-device bootstrap, rotate,
 * upgrade) must give the operator escrow key its wrapped copy atomically: when
 * escrow is enabled the envelope is REQUIRED (400 when missing) and upserted;
 * when disabled it is ignored entirely and never persisted. Device approval
 * does NOT route through here — approving a device does not change the AK.
 *
 * `ORG_ESCROW_ENABLED` is all this needs (THU-866). The server holds no escrow
 * public key: the client wraps to the key its own build pins, so the envelope
 * arrives as opaque ciphertext and the only server-side decision left is whether
 * one is mandatory. That flag is what stops an account slipping through
 * unescrowed on a deployment that expects escrow.
 */
const persistOrgEnvelope = async (
  txDb: typeof DbType,
  settings: Settings,
  userId: string,
  orgEnvelope: string | undefined,
): Promise<void> => {
  if (!settings.orgEscrowEnabled) {
    return
  }
  if (!orgEnvelope) {
    throw new BadRequestError('orgEnvelope is required when org escrow is enabled')
  }
  await upsertOrgEnvelope(txDb, { userId, wrappedAk: orgEnvelope })
}

/** Map a thrown BadRequest/Forbidden/SchemeConflict error onto the response; rethrow anything else. */
const mapEncryptionError = (err: unknown, set: { status?: number | string }): { error: string } => {
  if (err instanceof BadRequestError) {
    set.status = 400
    return { error: err.message }
  }
  if (err instanceof ForbiddenError) {
    set.status = 403
    return { error: err.message }
  }
  if (err instanceof SchemeConflictError || err instanceof KeyConflictError) {
    set.status = 409
    return { error: err.message }
  }
  throw err
}

/**
 * Encryption API routes for device registration, envelope management, the
 * wrapped-DEK keyring, challenge-response, AK rotation, and the v1→v2 upgrade.
 * All routes require authentication via session.
 */
export const createEncryptionRoutes = (auth: Auth, database: typeof DbType, settings: Settings) =>
  new Elysia()
    .use(createAuthMacro(auth))
    .post(
      '/devices',
      async ({ body, set, user: sessionUser, session }) => {
        const userId = sessionUser!.id
        const { deviceId, publicKey, mlkemPublicKey, name } = body

        // Check if device already exists (fast-path before transaction)
        const existingDevice = await getDeviceById(database, deviceId)

        if (existingDevice) {
          // Device belongs to a different user
          if (existingDevice.userId !== userId) {
            set.status = 409
            return { error: 'Device ID already taken' }
          }

          // Revoked — device cannot re-register
          if (existingDevice.revokedAt != null) {
            set.status = 403
            return { error: 'Device has been revoked' }
          }

          // Encryption-registered device (has publicKey): return current state
          if (existingDevice.publicKey) {
            if (existingDevice.trusted) {
              // NO session link here (THU-873). This branch takes an unverified
              // client-supplied `deviceId`, so linking would let any session
              // claim any already-trusted device — the rebind hole that made
              // pinning `getCallerDevice` to `session.deviceId` worthless. A
              // returning device binds through the sealed-nonce handshake
              // (`GET /devices/me/bind-challenge` + `POST /devices/me/bind`),
              // which proves it holds this device's private key.
              // The envelope below is safe to return unbound: it is the AK
              // wrapped TO this device's public keys, useless without them.
              const envelope = await getEnvelopeByDeviceId(database, deviceId, userId)
              return {
                trusted: true as const,
                envelope: envelope?.wrappedCk ?? null,
              }
            }
            // Non-trusted device re-registering (reopen modal after deny/cancel):
            // fall through to registerDevice which upserts with approvalPending=true
          }

          // Pre-encryption device (no publicKey): fall through to register with publicKey
        }

        // Wrap limit check + registration in a transaction to prevent TOCTOU race
        const deviceName = name || 'Unknown device'
        const result = await database.transaction(async (tx) => {
          const txDb = tx as unknown as typeof database

          // Re-check device inside transaction to close race window
          const freshDevice = await getDeviceById(txDb, deviceId)
          if (!freshDevice) {
            const activeCount = await countActiveDevices(txDb, userId)
            if (activeCount >= maxDevicesPerUser) {
              return { limitReached: true as const }
            }
          }

          const registered = await registerDevice(txDb, {
            id: deviceId,
            userId,
            name: deviceName,
            publicKey,
            mlkemPublicKey,
          })

          // If upsert returned no rows, another user claimed this device ID
          if (registered.length === 0 || registered[0].userId !== userId) {
            return { taken: true as const }
          }

          return { ok: true as const, pendingSince: registered[0].lastSeen }
        })

        if ('limitReached' in result) {
          set.status = 422
          return { error: 'Device limit reached' }
        }

        if ('taken' in result) {
          set.status = 409
          return { error: 'Device ID already taken' }
        }

        await linkSessionToDevice(database, session.id, deviceId, userId)
        // `pendingSince` identifies THIS registration. The client echoes it back
        // on cancel so a cancel that was issued for an earlier attempt cannot
        // clear a newer one (see `denyDevice`).
        // `lastSeen` is nullable in the schema; `registerDevice` always stamps it,
        // and omitting the token simply falls back to an unscoped cancel.
        return { trusted: false as const, pendingSince: result.pendingSince?.toISOString() }
      },
      {
        auth: true,
        body: t.Object({
          deviceId: t.String({ maxLength: 36 }),
          publicKey: t.String({ maxLength: 200 }),
          mlkemPublicKey: t.String({ maxLength: 1700 }),
          name: t.Optional(t.String({ maxLength: 100 })),
        }),
      },
    )
    // Store a device envelope. `wrappedCK` carries the ACCOUNT KEY (AK) in v2 —
    // the historical name is kept to avoid wire churn.
    //
    // Two shapes:
    // 1. First-device bootstrap — NO encryption metadata exists, caller==target:
    //    requires the full atomic v2 setup payload (canary + signing key +
    //    kdf_salt + recovery slot + initial wrapped keyring incl key_id "0").
    //    Everything is created in one transaction so half-configured accounts
    //    cannot exist.
    // 2. Approval / self-recovery — metadata exists: requires a ChallengeProof
    //    (operation 'approve'). A pre-flip v1 account (NULL signing key) fails
    //    verification closed and must go through POST /encryption/upgrade first;
    //    an active v2 account has no static-secret override.
    .post(
      '/devices/:deviceId/envelope',
      async ({ params, body, request, set, user: sessionUser, session }) => {
        const userId = sessionUser!.id
        const { deviceId } = params
        const {
          wrappedCK,
          proof,
          canaryIv,
          canaryCtext,
          signingPublicKey,
          kdfSalt,
          wrappedKeys,
          recoveryEcdhPublicKey,
          recoveryMlkemPublicKey,
          recoveryWrappedAK,
          recoveryAttestation,
          orgEnvelope,
        } = body

        // Pre-transaction fast-path rejection; re-checked inside tx to close race window.
        const device = await getDeviceById(database, deviceId)
        if (!device || device.userId !== userId) {
          set.status = 404
          return { error: 'Device not found' }
        }
        if (device.revokedAt != null) {
          set.status = 403
          return { error: 'Device has been revoked' }
        }

        const callerDeviceId = request.headers.get('x-device-id')?.trim()
        if (!callerDeviceId) {
          set.status = 400
          return { error: 'X-Device-ID header is required' }
        }
        // THU-873: the header is a claim; the session's bound device is the
        // identity. First registration binds the session, so an enrolling
        // device reaches this route already bound.
        if (!session.deviceId) {
          set.status = 403
          return { error: 'Session is not bound to a device' }
        }
        if (session.deviceId !== callerDeviceId) {
          set.status = 403
          return { error: 'X-Device-ID does not match the authenticated device' }
        }

        // Only the device itself can re-key its own envelope (prevents overwrite attacks)
        if (device.trusted && callerDeviceId !== deviceId) {
          set.status = 409
          return { error: 'Cannot overwrite envelope of an already-trusted device' }
        }

        try {
          await database.transaction(async (tx) => {
            const txDb = tx as unknown as typeof database

            // Serialize concurrent device approvals for this user to prevent cap bypass and
            // to serialize against POST /rotate, /upgrade and revoke (same lock). Auto-releases
            // on commit/rollback.
            await txDb.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${userId})::bigint)`)

            const metadata = await getEncryptionMetadata(txDb, userId)

            if (!metadata) {
              // ── Shape 1: first-device bootstrap (atomic v2 setup) ──
              const envelopesExist = await hasEnvelopesForUser(txDb, userId)
              if (envelopesExist || callerDeviceId !== deviceId) {
                throw new ForbiddenError('Encryption is not set up — only first-device bootstrap can store envelopes')
              }
              if (
                !canaryIv ||
                !canaryCtext ||
                !signingPublicKey ||
                !kdfSalt ||
                !wrappedKeys?.length ||
                !recoveryEcdhPublicKey ||
                !recoveryMlkemPublicKey ||
                !recoveryWrappedAK ||
                !recoveryAttestation
              ) {
                throw new BadRequestError(
                  'First device bootstrap requires canaryIv, canaryCtext, signingPublicKey, kdfSalt, wrappedKeys, recoveryEcdhPublicKey, recoveryMlkemPublicKey, recoveryWrappedAK, and recoveryAttestation',
                )
              }
              // Exactly `"0"`, nothing else (THU-871). Bootstrap is a MINT path,
              // so an extra id here would enter the keyring un-vetted — including
              // one crafted to collide with a later allocation and wedge every
              // future DEK rotation. The legitimate client submits precisely one.
              if (wrappedKeys.length !== 1 || wrappedKeys[0]!.keyId !== initialKeyId) {
                throw new BadRequestError(
                  `First device bootstrap requires exactly one wrapped key, for key_id '${initialKeyId}'`,
                )
              }
              await insertEncryptionMetadataIfNotExists(txDb, {
                userId,
                canaryIv,
                canaryCtext,
                signingPublicKey,
                kdfSalt,
                recoveryEcdhPublicKey,
                recoveryMlkemPublicKey,
                recoveryWrappedAk: recoveryWrappedAK,
                recoveryAttestation,
              })
              for (const entry of wrappedKeys) {
                const inserted = await insertWrappedKey(txDb, {
                  userId,
                  keyId: entry.keyId,
                  wrappedKey: entry.wrappedKey,
                })
                if (inserted.length === 0) {
                  // A pre-existing row for this key_id means the keyring was
                  // written before setup — the bootstrap's own DEK would be
                  // discarded and the account born unreadable (THU-871).
                  throw new KeyConflictError(`key_id '${entry.keyId}' already exists — cannot bootstrap over it`)
                }
              }
              // Bootstrap mints the account's first AK — escrow it in the same tx.
              await persistOrgEnvelope(txDb, settings, userId, orgEnvelope)
            } else {
              // ── Shape 2: metadata exists — approval / self-recovery. Every path
              // requires a valid 'approve' proof; a pre-flip v1 account (NULL
              // signing key) fails closed and must upgrade first.
              if (!proof) {
                throw new ForbiddenError('Challenge proof required for device approval')
              }
              if (!(await verifyChallengeSignature(txDb, userId, proof, 'approve', callerDeviceId))) {
                throw new ForbiddenError('Invalid challenge proof')
              }

              if (callerDeviceId !== deviceId) {
                // Approving another device — caller-trust check (defense-in-depth)
                const callerDevice = await getDeviceById(txDb, callerDeviceId)
                if (!callerDevice || callerDevice.userId !== userId) {
                  throw new ForbiddenError('Caller device not found')
                }
                if (!callerDevice.trusted) {
                  throw new ForbiddenError('Only trusted devices can store envelopes')
                }
              }
              // caller==target: self-recovery / envelope re-key — the proof is the gate.
            }

            // Re-check target device inside transaction to close race window
            const targetDevice = await getDeviceById(txDb, deviceId)
            if (!targetDevice || targetDevice.revokedAt != null) {
              throw new ForbiddenError('Device has been revoked')
            }

            // Store envelope (carries the AK)
            await upsertEnvelope(txDb, { deviceId, userId, wrappedCk: wrappedCK })

            // Approval-only state transition: cap check + markDeviceTrusted only run when
            // transitioning untrusted → trusted. For re-key (already-trusted devices rotating
            // envelopes), the upsertEnvelope above is the only state change needed.
            if (!targetDevice.trusted) {
              const activeCount = await countActiveDevices(txDb, userId)
              if (activeCount >= maxDevicesPerUser) {
                throw new ForbiddenError('Device limit reached — revoke an existing device first')
              }
              // Check rows returned to detect a concurrent revoke between the in-tx read and this UPDATE.
              const updated = await markDeviceTrusted(txDb, deviceId, userId)
              if (updated.length === 0) {
                throw new ForbiddenError('Device has been revoked')
              }
            }
          })
        } catch (err) {
          return mapEncryptionError(err, set)
        }

        return { trusted: true as const }
      },
      {
        auth: true,
        body: t.Object({
          wrappedCK: t.String({ maxLength: 2200 }),
          proof: t.Optional(proofSchema),
          canaryIv: t.Optional(t.String({ maxLength: 500 })),
          canaryCtext: t.Optional(t.String({ maxLength: 500 })),
          signingPublicKey: t.Optional(t.String({ maxLength: 500 })),
          kdfSalt: t.Optional(t.String({ maxLength: 500 })),
          wrappedKeys: t.Optional(t.Array(wrappedKeyEntrySchema, { maxItems: maxKeyringKeys })),
          recoveryEcdhPublicKey: t.Optional(t.String({ maxLength: 200 })),
          recoveryMlkemPublicKey: t.Optional(t.String({ maxLength: 1700 })),
          recoveryWrappedAK: t.Optional(t.String({ maxLength: 2200 })),
          recoveryAttestation: t.Optional(t.String({ maxLength: 200 })),
          orgEnvelope: t.Optional(t.String({ maxLength: 500 })),
        }),
      },
    )
    .get(
      '/devices/me/envelope',
      async ({ request, set, user: sessionUser, session }) => {
        const userId = sessionUser!.id
        const deviceId = request.headers.get('x-device-id')?.trim()

        if (!deviceId) {
          set.status = 400
          return { error: 'X-Device-ID header is required' }
        }
        // THU-873: a device may only fetch ITS OWN envelope. The blob is wrapped
        // to this device's public keys so it is useless to another session, but
        // serving it on a client-set header alone would still leak which devices
        // are enrolled.
        if (!session.deviceId || session.deviceId !== deviceId) {
          set.status = 403
          return { error: 'X-Device-ID does not match the authenticated device' }
        }

        const device = await getDeviceById(database, deviceId)
        if (!device || device.userId !== userId) {
          set.status = 404
          return { error: 'Device not found' }
        }
        if (device.revokedAt != null) {
          set.status = 403
          return { error: 'Device has been revoked' }
        }

        // Device was denied or cancelled — not pending, not trusted, not revoked
        if (!device.approvalPending && !device.trusted) {
          set.status = 422
          return { error: 'Approval not pending' }
        }

        const envelope = await getEnvelopeByDeviceId(database, deviceId, userId)
        if (!envelope) {
          set.status = 404
          return { error: 'Envelope not found' }
        }

        return {
          trusted: device.trusted,
          // Carries the AK in v2 — field name kept for wire compatibility.
          wrappedCK: envelope.wrappedCk,
        }
      },
      { auth: true },
    )
    // Encryption metadata (still at /encryption/canary — the poll clients already
    // do at unlock). Returns the shared EncryptionMetadataResponse DTO;
    // `key_version`/`primary_key_id`/`scheme_version` ride along so devices detect
    // AK/DEK rotations and the v1→v2 flip by polling (plan §2.4 transport).
    // `signing_public_key`/`kdf_salt` are null for a pre-flip v1 account.
    .get(
      '/encryption/canary',
      async ({ set, user: sessionUser }) => {
        const userId = sessionUser!.id

        const metadata = await getEncryptionMetadata(database, userId)
        if (!metadata) {
          set.status = 404
          return { error: 'Encryption not set up' }
        }

        return {
          canary_iv: metadata.canaryIv,
          canary_ctext: metadata.canaryCtext,
          kdf_salt: metadata.kdfSalt,
          signing_public_key: metadata.signingPublicKey,
          recovery_attestation: metadata.recoveryAttestation,
          recovery_ecdh_public_key: metadata.recoveryEcdhPublicKey,
          recovery_mlkem_public_key: metadata.recoveryMlkemPublicKey,
          recovery_wrapped_ak: metadata.recoveryWrappedAk,
          key_version: metadata.keyVersion,
          primary_key_id: metadata.primaryKeyId,
          scheme_version: metadata.schemeVersion,
        }
      },
      { auth: true },
    )
    // Wrapped-DEK keyring. ACCESS RULE: any authenticated, NON-REVOKED device of
    // the user may read wrapped keys, including pending ones. A recovering device
    // must fetch the wrapped DEK BEFORE it is trusted (mnemonic → AK → unwrap DEK
    // → decrypt canary → derive signing key → prove possession). The AES-KW
    // wrapping under the AK is the real cryptographic gate — a wrapped key is
    // useless without the AK. Revoked devices are rejected (403).
    .get(
      '/encryption/keys',
      async ({ request, set, user: sessionUser, session }) => {
        const userId = sessionUser!.id
        const caller = await getCallerDevice(database, userId, request, session)
        if ('error' in caller) {
          set.status = caller.status
          return { error: caller.error }
        }

        const keys = await listWrappedKeys(database, userId)
        return {
          keys: keys.map((key) => ({ key_id: key.keyId, wrapped_key: key.wrappedKey })),
        }
      },
      { auth: true },
    )
    // The exact device set an AK rotation / upgrade must cover, with the public
    // keys needed to wrap for each — served from the SAME predicate
    // `assertEnvelopeCoverage` validates against. Clients previously derived this
    // from their PowerSync-synced `devices` table, so a replication lag (two
    // devices migrating at once, a freshly approved peer) produced envelopes the
    // server then rejected as incomplete, with no way to recover. Public keys are
    // not secrets — they already sync to every device on the account.
    .get(
      '/encryption/envelope-targets',
      async ({ request, set, user: sessionUser, session }) => {
        const userId = sessionUser!.id
        const caller = await getCallerDevice(database, userId, request, session)
        if ('error' in caller) {
          set.status = caller.status
          return { error: caller.error }
        }

        const devices = await listEnvelopeCapableDevices(database, userId)
        return {
          devices: devices.map((device) => ({
            device_id: device.id,
            public_key: device.publicKey,
            mlkem_public_key: device.mlkemPublicKey,
          })),
        }
      },
      { auth: true },
    )
    .get(
      '/encryption/keys/:keyId',
      async ({ params, request, set, user: sessionUser, session }) => {
        const userId = sessionUser!.id
        const caller = await getCallerDevice(database, userId, request, session)
        if ('error' in caller) {
          set.status = caller.status
          return { error: caller.error }
        }

        const key = await getWrappedKey(database, userId, params.keyId)
        if (!key) {
          set.status = 404
          return { error: 'Key not found' }
        }

        return { key_id: key.keyId, wrapped_key: key.wrappedKey }
      },
      { auth: true },
    )
    // NOTE: there is deliberately no standalone "mint a key_id" route (THU-871).
    // A new DEK is minted only as part of an AK rotation, via `newPrimaryKey` on
    // POST /encryption/rotate. That is what makes minting atomic (a failed
    // rotation adds nothing, so a retried revocation cannot ratchet the keyring),
    // guarantees every row is wrapped under the CURRENT AK (the mint happens in
    // the same request that installs that AK), and denies an in-origin script a
    // cheap endpoint for planting unopenable rows.
    // Issue a single-use challenge nonce bound to (user, operation, caller
    // device). Pending devices may request one — a recovering device needs an
    // 'approve' challenge before it is trusted; the signature is the real gate.
    // Revoked devices are rejected by getCallerDevice.
    .get(
      '/encryption/challenge',
      async ({ query, request, set, user: sessionUser, session }) => {
        const userId = sessionUser!.id

        const operation = query.operation
        if (!challengeOperations.includes(operation as ChallengeOperation)) {
          set.status = 400
          return { error: 'Invalid operation' }
        }

        const caller = await getCallerDevice(database, userId, request, session)
        if ('error' in caller) {
          set.status = caller.status
          return { error: caller.error }
        }

        const { nonce, expiresAt } = await issueChallengeNonce(database, {
          userId,
          operation: operation as ChallengeOperation,
          deviceId: caller.deviceId,
          ttlMs: challengeNonceTtlMs,
        })

        return { nonce, expires_at: expiresAt.toISOString() }
      },
      {
        auth: true,
        query: t.Object({ operation: t.String({ maxLength: 20 }) }),
      },
    )
    // Atomic AK rotation: replace every trusted device's envelope, re-anchor the
    // recovery slot, re-wrap EVERY key_id on the keyring under the new AK,
    // OPTIONALLY mint one new primary DEK, replace canary + signing key +
    // kdf_salt, and bump key_version — one all-or-nothing transaction under the
    // per-user advisory lock (shared with envelope approval, upgrade and revoke,
    // so rotation can't race them). Gated by a 'rotate' challenge signature.
    //
    // `newPrimaryKey` is the ONLY way a key_id enters an established keyring
    // (THU-871). Device revocation needs both rotations — a new DEK so future
    // writes use a key the removed device never held, and a new AK to lock it out
    // of the keyring — and doing them in one transaction is what makes the pair
    // atomic: a failure adds nothing, so retrying a revocation cannot grow the
    // keyring, and the minted DEK is wrapped under the very AK this request
    // installs, so it can never be stranded under a stale one.
    //
    // The recovery public keys normally match the stored ones (a silent rotation
    // keeps the user's phrase working); submitting DIFFERENT ones is the explicit
    // phrase-change path and is gated by the same proof.
    .post(
      '/encryption/rotate',
      async ({ body, request, set, user: sessionUser, session }) => {
        const userId = sessionUser!.id
        const caller = await getCallerDevice(database, userId, request, session)
        if ('error' in caller) {
          set.status = caller.status
          return { error: caller.error }
        }
        if (!caller.device.trusted) {
          set.status = 403
          return { error: 'Only trusted devices can rotate keys' }
        }

        try {
          const keyVersion = await database.transaction(async (tx) => {
            const txDb = tx as unknown as typeof database
            await txDb.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${userId})::bigint)`)

            // Verify inside the tx so nonce consumption serializes under the lock
            // (concurrent rotates: the second fails on its own nonce or on coverage
            // validation against the already-rotated state).
            if (!(await verifyChallengeSignature(txDb, userId, body.proof, 'rotate', caller.deviceId))) {
              throw new ForbiddenError('Invalid challenge proof')
            }

            const existingKeys = await listWrappedKeys(txDb, userId)
            assertRotateKeyCoverage(
              existingKeys.map((key) => key.keyId),
              body.wrappedKeys,
              body.newPrimaryKey,
            )
            const capableDeviceIds = await listEnvelopeCapableDeviceIds(txDb, userId)
            assertEnvelopeCoverage(capableDeviceIds, body.envelopes)
            assertRecoveryCoverage(body)

            for (const envelope of body.envelopes) {
              await upsertEnvelope(txDb, { deviceId: envelope.deviceId, userId, wrappedCk: envelope.wrappedCK })
            }
            for (const entry of body.wrappedKeys) {
              const updated = await updateWrappedKey(txDb, userId, entry.keyId, entry.wrappedKey)
              if (updated.length === 0) {
                // Unreachable under coverage validation + the advisory lock, but
                // a silently dropped re-wrap strands that key_id under the AK
                // about to be discarded, so it must abort rather than commit.
                throw new BadRequestError(`key_id '${entry.keyId}' vanished mid-rotation — aborting`)
              }
            }
            // The freshly minted primary DEK, already wrapped under the NEW AK
            // (THU-871). Minting inside the rotation transaction is what makes it
            // atomic: a rotation that fails anywhere adds no keyring row, so a
            // retried revocation cannot ratchet the keyring, and the new row can
            // never be wrapped under a stale AK.
            if (body.newPrimaryKey) {
              const inserted = await insertWrappedKey(txDb, {
                userId,
                keyId: body.newPrimaryKey.keyId,
                wrappedKey: body.newPrimaryKey.wrappedKey,
              })
              if (inserted.length === 0) {
                throw new KeyConflictError(`key_id '${body.newPrimaryKey.keyId}' already exists — mint aborted`)
              }
              await setPrimaryKeyId(txDb, userId, body.newPrimaryKey.keyId)
            }
            // The org envelope wraps the NEW AK — replaced atomically with the rotation.
            await persistOrgEnvelope(txDb, settings, userId, body.orgEnvelope)
            await replaceEncryptionMetadata(txDb, {
              userId,
              canaryIv: body.canaryIv,
              canaryCtext: body.canaryCtext,
              signingPublicKey: body.signingPublicKey,
              kdfSalt: body.kdfSalt,
              recoveryEcdhPublicKey: body.recoveryEcdhPublicKey,
              recoveryMlkemPublicKey: body.recoveryMlkemPublicKey,
              recoveryWrappedAk: body.recoveryWrappedAK,
              recoveryAttestation: body.recoveryAttestation,
            })
            const newVersion = await bumpKeyVersion(txDb, userId)
            if (newVersion == null) {
              throw new BadRequestError('Encryption not set up')
            }
            return newVersion
          })

          return { key_version: keyVersion }
        } catch (err) {
          return mapEncryptionError(err, set)
        }
      },
      {
        auth: true,
        body: t.Object({
          proof: proofSchema,
          envelopes: t.Array(envelopeEntrySchema, { minItems: 1, maxItems: maxDevicesPerUser }),
          wrappedKeys: t.Array(wrappedKeyEntrySchema, { minItems: 1, maxItems: maxKeyringKeys }),
          newPrimaryKey: t.Optional(newPrimaryKeySchema),
          canaryIv: t.String({ maxLength: 500 }),
          canaryCtext: t.String({ maxLength: 500 }),
          signingPublicKey: t.String({ maxLength: 500 }),
          kdfSalt: t.String({ maxLength: 500 }),
          recoveryEcdhPublicKey: t.String({ maxLength: 200 }),
          recoveryMlkemPublicKey: t.String({ maxLength: 1700 }),
          recoveryWrappedAK: t.String({ maxLength: 2200 }),
          recoveryAttestation: t.String({ maxLength: 200 }),
          orgEnvelope: t.Optional(t.String({ maxLength: 500 })),
        }),
      },
    )
    // v1→v2 migration (WS1). The migrator absorbs the legacy CK into the keyring
    // as the reserved read-only `"v1"` slot AND mints a fresh primary DEK `"0"`,
    // registers the signing key + kdf_salt + recovery slot, re-encrypts the canary
    // under the new primary DEK, writes a new-AK envelope for every trusted
    // device and for the phrase-derived recovery keypair, and flips
    // scheme_version 1→2 atomically (CAS) as the LAST step — one all-or-nothing
    // transaction under the per-user advisory lock.
    //
    // Gated ONLY by the D1 CK-possession proof (the signing key does not exist
    // pre-flip, so this is the bootstrap op and is NOT signature-gated); an
    // 'upgrade' nonce is consumed for replay protection. A second concurrent
    // migrator loses the CAS and gets a 409.
    .post(
      '/encryption/upgrade',
      async ({ body, request, set, user: sessionUser, session }) => {
        const userId = sessionUser!.id
        const caller = await getCallerDevice(database, userId, request, session)
        if ('error' in caller) {
          set.status = caller.status
          return { error: caller.error }
        }
        if (!caller.device.trusted) {
          set.status = 403
          return { error: 'Only trusted devices can upgrade encryption' }
        }

        try {
          const result = await database.transaction(async (tx) => {
            const txDb = tx as unknown as typeof database
            await txDb.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${userId})::bigint)`)

            // Replay protection only (bootstrap op — NOT signature-verified).
            const nonceRow = await consumeChallengeNonce(txDb, body.nonce)
            if (
              !nonceRow ||
              nonceRow.userId !== userId ||
              nonceRow.operation !== 'upgrade' ||
              nonceRow.deviceId !== caller.deviceId
            ) {
              throw new ForbiddenError('Invalid or expired upgrade nonce')
            }

            // D1 possession proof: only a device holding the v1 CK can produce the
            // canarySecret that hashes to the retained canary_secret_hash.
            if (!(await verifyPossessionProof(txDb, userId, body.possessionProof))) {
              throw new ForbiddenError('Invalid CK-possession proof')
            }

            assertUpgradeKeyCoverage(body.wrappedKeys, body.primaryKeyId)
            const capableDeviceIds = await listEnvelopeCapableDeviceIds(txDb, userId)
            assertEnvelopeCoverage(capableDeviceIds, body.envelopes)
            assertRecoveryCoverage(body)

            for (const entry of body.wrappedKeys) {
              const inserted = await insertWrappedKey(txDb, {
                userId,
                keyId: entry.keyId,
                wrappedKey: entry.wrappedKey,
              })
              if (inserted.length === 0) {
                throw new KeyConflictError(`key_id '${entry.keyId}' already exists — cannot absorb over it`)
              }
            }
            for (const envelope of body.envelopes) {
              await upsertEnvelope(txDb, { deviceId: envelope.deviceId, userId, wrappedCk: envelope.wrappedCK })
            }

            // Atomic last step: CAS scheme_version 1→2. A concurrent migrator that
            // already flipped leaves 0 rows → 409 (candidate AK never persisted).
            const flipped = await flipSchemeToV2(txDb, {
              userId,
              canaryIv: body.canaryIv,
              canaryCtext: body.canaryCtext,
              signingPublicKey: body.signingPublicKey,
              kdfSalt: body.kdfSalt,
              primaryKeyId: body.primaryKeyId,
              recoveryEcdhPublicKey: body.recoveryEcdhPublicKey,
              recoveryMlkemPublicKey: body.recoveryMlkemPublicKey,
              recoveryWrappedAk: body.recoveryWrappedAK,
              recoveryAttestation: body.recoveryAttestation,
            })
            if (!flipped) {
              throw new SchemeConflictError('Account already migrated to scheme v2')
            }
            // The org envelope wraps the NEW AK minted by this migration.
            await persistOrgEnvelope(txDb, settings, userId, body.orgEnvelope)
            return { keyVersion: flipped.keyVersion, schemeVersion: flipped.schemeVersion }
          })

          return { key_version: result.keyVersion, scheme_version: result.schemeVersion }
        } catch (err) {
          return mapEncryptionError(err, set)
        }
      },
      {
        auth: true,
        body: t.Object({
          nonce: t.String({ maxLength: 128 }),
          possessionProof: t.String({ maxLength: 500 }),
          envelopes: t.Array(envelopeEntrySchema, { minItems: 1, maxItems: maxDevicesPerUser }),
          wrappedKeys: t.Array(wrappedKeyEntrySchema, { minItems: 2, maxItems: maxKeyringKeys }),
          primaryKeyId: t.String({ minLength: 1, maxLength: 64, pattern: '^[^:]+$' }),
          canaryIv: t.String({ maxLength: 500 }),
          canaryCtext: t.String({ maxLength: 500 }),
          signingPublicKey: t.String({ maxLength: 500 }),
          kdfSalt: t.String({ maxLength: 500 }),
          recoveryEcdhPublicKey: t.String({ maxLength: 200 }),
          recoveryMlkemPublicKey: t.String({ maxLength: 1700 }),
          recoveryWrappedAK: t.String({ maxLength: 2200 }),
          recoveryAttestation: t.String({ maxLength: 200 }),
          orgEnvelope: t.Optional(t.String({ maxLength: 500 })),
        }),
      },
    )
    .post(
      '/devices/:deviceId/deny',
      async ({ params, body, request, set, user: sessionUser, session }) => {
        const userId = sessionUser!.id
        const callerDeviceId = request.headers.get('x-device-id')?.trim()

        if (!callerDeviceId) {
          set.status = 400
          return { error: 'X-Device-ID header is required' }
        }
        // THU-873: pin the caller to its session before trusting the header. The
        // signature below proves ACCOUNT key possession, which a revoked device
        // retains — only this check proves WHICH device is calling.
        if (!session.deviceId || session.deviceId !== callerDeviceId) {
          set.status = 403
          return { error: 'X-Device-ID does not match the authenticated device' }
        }

        // Proof-of-key-possession prevents X-Device-ID spoofing: only a device
        // holding the account signing key can sign the challenge.
        if (!(await verifyChallengeSignature(database, userId, body.proof, 'deny', callerDeviceId))) {
          set.status = 403
          return { error: 'Invalid challenge proof' }
        }

        // Caller must be a trusted device (defense-in-depth)
        const callerDevice = await getDeviceById(database, callerDeviceId)
        if (!callerDevice || callerDevice.userId !== userId || !callerDevice.trusted) {
          set.status = 403
          return { error: 'Only trusted devices can deny pending devices' }
        }

        // Target must be a pending device belonging to the same user
        const targetDevice = await getDeviceById(database, params.deviceId)
        if (!targetDevice || targetDevice.userId !== userId) {
          set.status = 404
          return { error: 'Device not found' }
        }
        if (targetDevice.trusted || targetDevice.revokedAt != null) {
          set.status = 409
          return { error: 'Device is not pending approval' }
        }

        const rows = await denyDevice(database, params.deviceId, userId)
        if (rows.length === 0) {
          set.status = 404
          return { error: 'Device not found' }
        }

        set.status = 204
      },
      {
        auth: true,
        body: t.Object({ proof: proofSchema }),
      },
    )
    .post(
      '/devices/:deviceId/node-id',
      async ({ params, body, request, set, user: sessionUser, session }) => {
        const userId = sessionUser!.id
        const callerDeviceId = request.headers.get('x-device-id')?.trim()

        if (!callerDeviceId) {
          set.status = 400
          return { error: 'X-Device-ID header is required' }
        }

        // THU-873: pin the caller to its session first — the account signing key
        // the proof below checks is retained by a revoked device, so it cannot
        // establish WHICH device is attesting.
        if (!session.deviceId || session.deviceId !== callerDeviceId) {
          set.status = 403
          return { error: 'X-Device-ID does not match the authenticated device' }
        }

        // Proof-of-key-possession prevents X-Device-ID spoofing: only a device
        // holding the account signing key can sign the challenge. Attesting
        // another device's P2P identity is a trusted-device admin action gated
        // with the 'approve' operation (challengeOperations has no 'node-id').
        if (!(await verifyChallengeSignature(database, userId, body.proof, 'approve', callerDeviceId))) {
          set.status = 403
          return { error: 'Invalid challenge proof' }
        }

        // Caller must be a trusted device (defense-in-depth: only a trusted app
        // device may attest another device's P2P identity).
        const callerDevice = await getDeviceById(database, callerDeviceId)
        if (!callerDevice || callerDevice.userId !== userId || !callerDevice.trusted) {
          set.status = 403
          return { error: 'Only trusted devices can set a device node ID' }
        }

        const updated = await setDeviceNodeId(database, params.deviceId, userId, body.nodeId)
        if (updated.length === 0) {
          set.status = 404
          return { error: 'Device not found' }
        }

        return { nodeId: body.nodeId }
      },
      {
        auth: true,
        body: t.Object({
          nodeId: t.String({ minLength: 1, maxLength: 2048 }),
          proof: proofSchema,
        }),
      },
    )
    // Self-enroll: a device binds its OWN iroh endpoint identity (node_id) — no challenge
    // proof. Proof-of-possession happens at the iroh handshake on connect, so declaring a
    // node_id you can't dial as grants nothing. The caller is pinned to the session's server-set
    // deviceId (from linkSessionToDevice), so it can only write the device its session is bound
    // to — not an arbitrary target the way the proof-gated POST /devices/:deviceId/node-id can.
    // The trust boundary is the account: a live same-account session may declare its own node_id.
    // Device revocation plus the bridge's heartbeat re-check mitigate a rogue session rather than
    // intra-account isolation here.
    .post(
      '/devices/me/node-id',
      async ({ body, request, set, user: sessionUser, session }) => {
        const userId = sessionUser!.id
        const callerDeviceId = request.headers.get('x-device-id')?.trim()

        if (!callerDeviceId) {
          set.status = 400
          return { error: 'X-Device-ID header is required' }
        }

        // Pin to the session's bound device. A null (never-linked) session.deviceId also fails
        // this, fail-closed. This is the server-side identity — X-Device-ID alone is client-set.
        if (session.deviceId !== callerDeviceId) {
          set.status = 403
          return { error: 'X-Device-ID does not match the authenticated device' }
        }

        const updated = await setDeviceNodeId(database, callerDeviceId, userId, body.nodeId)
        if (updated.length === 0) {
          set.status = 404
          return { error: 'Device not found' }
        }

        return { nodeId: body.nodeId }
      },
      {
        auth: true,
        body: t.Object({
          nodeId: t.String({ minLength: 1, maxLength: 2048 }),
        }),
      },
    )
    // Account allowlist: the trusted, non-revoked node_ids of the caller's account. The
    // bridge fetches this with a bearer, caches it, and auto-allows same-account iroh peers.
    // Scoped to the caller's user_id — never leaks another account's rows.
    .get(
      '/devices/allowlist',
      async ({ user: sessionUser }) => {
        const userId = sessionUser!.id
        const nodeIds = await getTrustedNodeIds(database, userId)
        return { nodeIds }
      },
      { auth: true },
    )
    // Register a BRIDGE device on the caller's account. Adding an ACP/MCP bridge in the
    // app registers it here as a device with server-set `device_type='bridge'` (clients can't set
    // device_type — it's deny-listed from PowerSync upload, so a bridge MUST be created via this
    // route, not raw sync). Inserted trusted + non-revoked because the user deliberately added
    // their own bridge. Scoped to the caller's account (registerBridgeDevice derives the row id
    // from userId, and the `bridge-` id namespace is reserved from client uploads), so it can
    // never write another user's row. node_id here is the bridge's SERVER NodeId; it surfaces in
    // getTrustedNodeIds (the account allowlist), which is intentional and harmless — no peer can
    // dial as the bridge's key without its ed25519 private key, so listing it grants nothing.
    // A revoked bridge is not silently re-added with the same NodeId. Registration reports the
    // tombstone so the caller can remove it explicitly before pairing again.
    .post(
      '/devices/bridge',
      async ({ body, set, user: sessionUser }) => {
        const userId = sessionUser!.id
        const name = body.name?.trim() || 'Bridge'
        const result = await database.transaction(async (tx) => {
          const existingBridge = await getDeviceById(tx, bridgeDeviceId(userId, body.nodeId))
          if (!existingBridge) {
            const activeCount = await countActiveDevices(tx, userId)
            if (activeCount >= maxDevicesPerUser) {
              return { limitReached: true as const }
            }
          }

          const [device] = await registerBridgeDevice(tx, { userId, nodeId: body.nodeId, name })
          if (!device) {
            const tombstone = await getDeviceById(tx, bridgeDeviceId(userId, body.nodeId))
            if (tombstone?.userId === userId && tombstone.revokedAt != null) {
              return { revoked: true as const }
            }
            throw new Error('Bridge device registration returned no device')
          }
          return { device }
        })

        if ('limitReached' in result) {
          set.status = 422
          return { error: 'Device limit reached' }
        }
        if ('revoked' in result) {
          set.status = 409
          return { error: 'Bridge device revoked' }
        }
        const { device } = result
        return { id: device.id, nodeId: device.nodeId, deviceType: device.deviceType }
      },
      {
        auth: true,
        body: t.Object({
          nodeId: t.String({ minLength: 1, maxLength: 2048 }),
          name: t.Optional(t.String({ maxLength: 100 })),
        }),
      },
    )
    .delete(
      '/devices/:deviceId',
      async ({ params, set, user: sessionUser }) => {
        const userId = sessionUser!.id
        const result = await database.transaction(async (tx) => {
          const device = await getDeviceById(tx, params.deviceId)
          if (!device || device.userId !== userId) {
            return { notFound: true as const }
          }
          if (device.deviceType !== 'bridge' || device.revokedAt == null) {
            return { notRemovable: true as const }
          }

          await revokeDeviceSessions(tx, params.deviceId, userId)
          const deleted = await deleteRevokedBridgeDevice(tx, params.deviceId, userId)
          return deleted.length > 0 ? { success: true as const } : { notFound: true as const }
        })

        if ('notFound' in result) {
          set.status = 404
          return { error: 'Device not found' }
        }
        if ('notRemovable' in result) {
          set.status = 409
          return { error: 'Only revoked bridge devices can be removed' }
        }
        return { success: true }
      },
      { auth: true },
    )
    // Device–session binding (THU-873), the handshake that makes every trust
    // route's `session.deviceId` gate meaningful. Two steps, both auth-gated:
    //
    //   1. GET  /devices/me/bind-challenge → a nonce SEALED to the claimed
    //      device's stored ECDH public key. The `X-Device-ID` header here is a
    //      CLAIM, not authority — anyone may ask for a challenge naming any
    //      device, and learn nothing, because only the holder of that device's
    //      private key can open the blob.
    //   2. POST /devices/me/bind → echo the opened nonce; the server consumes
    //      it and links the session to that device.
    //
    // This is the only path that binds a session to an already-trusted device.
    // `POST /devices` deliberately links only at first registration, when the
    // device is still pending and the link grants nothing.
    .get(
      '/devices/me/bind-challenge',
      async ({ request, set, user: sessionUser }) => {
        const userId = sessionUser!.id
        const deviceId = request.headers.get('x-device-id')?.trim()

        if (!deviceId) {
          set.status = 400
          return { error: 'X-Device-ID header is required' }
        }

        const device = await getDeviceById(database, deviceId)
        if (!device || device.userId !== userId) {
          set.status = 404
          return { error: 'Device not found' }
        }
        if (device.revokedAt != null) {
          set.status = 403
          return { error: 'Device has been revoked' }
        }
        // A keyless row (a bridge, or a v1 device that never published hybrid
        // keys) has nothing to seal to, so it can never bind — and never needs
        // to: nothing keyless reaches a route that resolves a caller device.
        if (!device.publicKey) {
          set.status = 409
          return { error: 'Device has no key material to bind with' }
        }

        const { nonce, expiresAt } = await issueChallengeNonce(database, {
          userId,
          operation: bindOperation,
          deviceId,
          ttlMs: challengeNonceTtlMs,
        })

        return { sealed: await sealBindNonce(device.publicKey, nonce), expires_at: expiresAt.toISOString() }
      },
      { auth: true },
    )
    .post(
      '/devices/me/bind',
      async ({ body, set, user: sessionUser, session }) => {
        const userId = sessionUser!.id

        // Single-use: `consumeChallengeNonce` flips `consumed` in one UPDATE, so
        // a replay matches 0 rows. Only a device that OPENED the sealed blob
        // knows this value.
        const consumed = await consumeChallengeNonce(database, body.nonce)
        if (
          !consumed ||
          consumed.userId !== userId ||
          consumed.operation !== bindOperation ||
          consumed.deviceId !== body.deviceId
        ) {
          set.status = 403
          return { error: 'Invalid or expired bind nonce' }
        }

        // Re-check state at bind time: the device may have been revoked between
        // the challenge and this call.
        const device = await getDeviceById(database, body.deviceId)
        if (!device || device.userId !== userId) {
          set.status = 404
          return { error: 'Device not found' }
        }
        if (device.revokedAt != null) {
          set.status = 403
          return { error: 'Device has been revoked' }
        }

        await linkSessionToDevice(database, session.id, body.deviceId, userId)

        return { deviceId: body.deviceId }
      },
      {
        auth: true,
        body: t.Object({
          deviceId: t.String({ maxLength: 36 }),
          nonce: t.String({ maxLength: 128 }),
        }),
      },
    )
    .post(
      '/devices/me/cancel-pending',
      async ({ body, request, set, user: sessionUser, session }) => {
        const userId = sessionUser!.id
        const deviceId = request.headers.get('x-device-id')?.trim()

        if (!deviceId) {
          set.status = 400
          return { error: 'X-Device-ID header is required' }
        }

        // THU-873: only the device whose session this is may cancel its own
        // pending registration.
        if (!session.deviceId || session.deviceId !== deviceId) {
          set.status = 403
          return { error: 'X-Device-ID does not match the authenticated device' }
        }

        const device = await getDeviceById(database, deviceId)
        if (!device || device.userId !== userId) {
          set.status = 404
          return { error: 'Device not found' }
        }

        if (device.trusted || device.revokedAt != null) {
          set.status = 409
          return { error: 'Device is not pending approval' }
        }

        // Scoped to the registration it was issued for. Clients fire this
        // without awaiting it (the modal closes immediately), so a slow cancel
        // could otherwise land after the user retried and wipe the FRESH pending
        // request — the retry vanished with the peer showing "Request denied".
        const cancelled = await denyDevice(
          database,
          deviceId,
          userId,
          body?.pendingSince ? new Date(body.pendingSince) : undefined,
        )
        if (cancelled.length === 0) {
          // Superseded by a newer registration — leave it alone. Not an error:
          // the request this cancel referred to is already gone.
          set.status = 409
          return { error: 'Pending request was superseded' }
        }
        set.status = 204
      },
      { auth: true, body: t.Optional(t.Object({ pendingSince: t.Optional(t.String({ maxLength: 40 })) })) },
    )
