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
  listTrustedDeviceIds,
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
import { getOrgEscrowKey, type OrgEscrowKey } from '@/lib/org-escrow'
import { safeErrorHandler } from '@/middleware/error-handling'
import {
  type ChallengeOperation,
  type OrgPublicKeyResponse,
  type WrappedKeyEntry,
  challengeNonceTtlMs,
  challengeOperations,
  initialKeyId,
  legacyKeyId,
  orgEnvelopeLength,
  orgEnvelopeVersion,
  uncompressedPointPrefix,
} from '@shared/e2ee-types'
import { sql } from 'drizzle-orm'
import { Elysia, t } from 'elysia'

const maxDevicesPerUser = 10

/** Thrown when a concurrent migrator already flipped the account (CAS 1→2 lost) — mapped to 409. */
class SchemeConflictError extends Error {}

/** Elysia schema for the shared ChallengeProof request DTO. */
const proofSchema = t.Object({
  signature: t.String({ maxLength: 200 }),
  nonce: t.String({ maxLength: 128 }),
  operation: t.Union(challengeOperations.map((op) => t.Literal(op))),
  deviceId: t.String({ maxLength: 36 }),
})

/** Elysia schema for one wrapped-DEK keyring entry. key_id is a wire-format segment — no ':' allowed. */
const wrappedKeyEntrySchema = t.Object({
  keyId: t.String({ minLength: 1, maxLength: 64, pattern: '^[^:]+$' }),
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

/**
 * Resolve the caller's device from the X-Device-ID header: must be present,
 * belong to the authenticated user, and not be revoked. Trust is NOT required
 * here — routes that need a trusted caller check `device.trusted` themselves.
 */
const getCallerDevice = async (
  database: typeof DbType,
  userId: string,
  request: Request,
): Promise<CallerDeviceResult> => {
  const deviceId = request.headers.get('x-device-id')?.trim()
  if (!deviceId) {
    return { status: 400, error: 'X-Device-ID header is required' }
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
 * new-AK envelope for EXACTLY the set of trusted, non-revoked devices — a
 * missing one locks a device out; an extra one hands the new AK to a
 * revoked/pending device. Throws BadRequestError on any mismatch.
 */
const assertEnvelopeCoverage = (trustedDeviceIds: string[], envelopes: Array<{ deviceId: string }>): void => {
  const trusted = new Set(trustedDeviceIds)
  const submitted = new Set(envelopes.map((envelope) => envelope.deviceId))
  if (submitted.size !== envelopes.length) {
    throw new BadRequestError('Duplicate deviceId in envelopes')
  }
  const missing = [...trusted].filter((deviceId) => !submitted.has(deviceId))
  if (missing.length > 0) {
    throw new BadRequestError(`envelopes must cover every trusted device — missing: ${missing.join(', ')}`)
  }
  const unknown = [...submitted].filter((deviceId) => !trusted.has(deviceId))
  if (unknown.length > 0) {
    throw new BadRequestError(`envelopes contains non-trusted devices: ${unknown.join(', ')}`)
  }
}

/**
 * AK-rotation keyring coverage: the FULL keyring must be re-wrapped under the
 * new AK — re-wrapping a subset strands the missing key_ids under the discarded
 * old AK (permanent data loss). Rotation never mints, so unknown key_ids are
 * rejected too. This naturally requires the `"v1"` slot when the account carries
 * one (plan Risk 1). Throws BadRequestError on any mismatch.
 */
const assertRotateKeyCoverage = (existingKeyIds: string[], wrappedKeys: WrappedKeyEntry[]): void => {
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
}

/**
 * Upgrade keyring coverage: the migrated keyring MUST contain BOTH a fresh
 * primary DEK `"0"` (post-flip writes need an encrypt-capable primary) AND the
 * absorbed legacy `"v1"` slot (without it, all legacy data is stranded). Throws
 * BadRequestError when either is missing (plan §4 Track A upgrade).
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
  // The primary MUST be the freshly-minted encrypt-capable DEK "0" — never the
  // read-only "v1" slot or a key_id absent from the keyring, either of which
  // would break every post-flip write.
  if (primaryKeyId !== initialKeyId) {
    throw new BadRequestError(`upgrade primary_key_id must be '${initialKeyId}'`)
  }
}

/**
 * Refuse anything that isn't the frozen wire shape, so a buggy client can't
 * store a string the operator only discovers is garbage at recovery time.
 *
 * This is a sanity check, NOT an integrity guarantee: the server holds no
 * private key, so it cannot tell a real envelope from 106 well-formed bytes
 * wrapping nothing — or wrapping to an attacker's key. A hostile client can
 * still poison its own escrow copy; only an operator-side test recovery detects
 * that.
 */
const assertOrgEnvelopeShape = (orgEnvelope: string): void => {
  const bytes = Buffer.from(orgEnvelope, 'base64')
  if (bytes.length !== orgEnvelopeLength || bytes[0] !== orgEnvelopeVersion || bytes[1] !== uncompressedPointPrefix) {
    throw new BadRequestError('orgEnvelope is not a well-formed org KMS escrow envelope')
  }
}

/**
 * Persist the AK's escrow copy inside the caller's transaction. Every
 * AK-producing operation (first-device bootstrap, rotate, upgrade — NOT device
 * approval, which doesn't touch the AK) must call this, or the escrow copy is
 * left wrapping a stale AK. When escrow is disabled this is a no-op even if the
 * client still sent an envelope — no new row is written, but any row an earlier
 * enabled period left behind stays: nothing deletes from `org_envelopes`, so
 * after a disable + rotate it wraps a retired AK. Cleaning that up is the
 * escrow-disable rotation flow the docs list as a non-goal.
 */
const persistOrgEnvelope = async (
  txDb: typeof DbType,
  escrowKey: OrgEscrowKey | null,
  userId: string,
  orgEnvelope: string | undefined,
): Promise<void> => {
  if (!escrowKey) {
    return
  }
  if (!orgEnvelope) {
    throw new BadRequestError('orgEnvelope is required when org key escrow is enabled')
  }
  assertOrgEnvelopeShape(orgEnvelope)
  await upsertOrgEnvelope(txDb, {
    userId,
    wrappedAk: orgEnvelope,
    kmsKeyFingerprint: escrowKey.fingerprint,
  })
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
  if (err instanceof SchemeConflictError) {
    set.status = 409
    return { error: err.message }
  }
  throw err
}

/**
 * Encryption API routes for device registration, envelope management, the
 * wrapped-DEK keyring, challenge-response, AK rotation, the v1→v2 upgrade, and
 * the org escrow public key.
 * All routes require authentication via session.
 */
export const createEncryptionRoutes = (auth: Auth, settings: Settings, database: typeof DbType) => {
  // Settings are read once per process, so the escrow key is fixed for the life
  // of this router — resolve it here rather than per request.
  const orgEscrow = getOrgEscrowKey(settings)

  return (
    new Elysia()
      // Plugins don't inherit the main app's error handler, so without this an
      // unexpected throw surfaces as a bare 500 with nothing in the logs naming
      // the cause.
      .onError(safeErrorHandler)
      .use(createAuthMacro(auth))
      // Org key escrow POC: the public key + fingerprint clients wrap the AK
      // against, or all-null when escrow is disabled. Session-authed like every
      // route here, but deliberately readable before THIS device is trusted —
      // first-device setup needs it before it has an envelope.
      .get(
        '/encryption/org-key',
        (): OrgPublicKeyResponse =>
          orgEscrow ? { enabled: true, ...orgEscrow } : { enabled: false, publicKey: null, fingerprint: null },
        { auth: true },
      )
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
                await linkSessionToDevice(database, session.id, deviceId, userId)
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

            return { ok: true as const }
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
          return { trusted: false as const }
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
      //    kdf_salt + initial wrapped keyring incl key_id "0"). Everything is
      //    created in one transaction so half-configured accounts cannot exist.
      // 2. Approval / self-recovery — metadata exists: requires a ChallengeProof
      //    (operation 'approve'). A pre-flip v1 account (NULL signing key) fails
      //    verification closed and must go through POST /encryption/upgrade first;
      //    an active v2 account has no static-secret override.
      .post(
        '/devices/:deviceId/envelope',
        async ({ params, body, request, set, user: sessionUser }) => {
          const userId = sessionUser!.id
          const { deviceId } = params
          const { wrappedCK, proof, canaryIv, canaryCtext, signingPublicKey, kdfSalt, wrappedKeys, orgEnvelope } = body

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

          // Only the device itself can re-key its own envelope (prevents overwrite attacks)
          if (device.trusted && callerDeviceId !== deviceId) {
            set.status = 409
            return { error: 'Cannot overwrite envelope of an already-trusted device' }
          }

          // Harmless on the approval branch, which never persists an envelope.
          const orgEscrow = await getOrgEscrowKey(settings)

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
                if (!canaryIv || !canaryCtext || !signingPublicKey || !kdfSalt || !wrappedKeys?.length) {
                  throw new BadRequestError(
                    'First device bootstrap requires canaryIv, canaryCtext, signingPublicKey, kdfSalt, and wrappedKeys',
                  )
                }
                if (!wrappedKeys.some((entry) => entry.keyId === initialKeyId)) {
                  throw new BadRequestError(
                    `First device bootstrap requires a wrapped key for key_id '${initialKeyId}'`,
                  )
                }
                await persistOrgEnvelope(txDb, orgEscrow, userId, orgEnvelope)
                await insertEncryptionMetadataIfNotExists(txDb, {
                  userId,
                  canaryIv,
                  canaryCtext,
                  signingPublicKey,
                  kdfSalt,
                })
                for (const entry of wrappedKeys) {
                  await insertWrappedKey(txDb, { userId, keyId: entry.keyId, wrappedKey: entry.wrappedKey })
                }
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
            wrappedKeys: t.Optional(t.Array(wrappedKeyEntrySchema, { maxItems: 100 })),
            orgEnvelope: t.Optional(t.String({ maxLength: 500 })),
          }),
        },
      )
      .get(
        '/devices/me/envelope',
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
        async ({ request, set, user: sessionUser }) => {
          const userId = sessionUser!.id
          const caller = await getCallerDevice(database, userId, request)
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
      .get(
        '/encryption/keys/:keyId',
        async ({ params, request, set, user: sessionUser }) => {
          const userId = sessionUser!.id
          const caller = await getCallerDevice(database, userId, request)
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
      // Mint a NEW key_id (DEK rotation / workspace DEK). Idempotent per key_id
      // (insertWrappedKey is ON CONFLICT DO NOTHING) — this route can NEVER
      // overwrite an existing key's wrapping; AK-rotation re-wrap goes through
      // POST /encryption/rotate only.
      .post(
        '/encryption/keys',
        async ({ body, request, set, user: sessionUser }) => {
          const userId = sessionUser!.id
          const caller = await getCallerDevice(database, userId, request)
          if ('error' in caller) {
            set.status = caller.status
            return { error: caller.error }
          }
          if (!caller.device.trusted) {
            set.status = 403
            return { error: 'Only trusted devices can add keys' }
          }

          await database.transaction(async (tx) => {
            const txDb = tx as unknown as typeof database
            // Same per-user advisory lock as /rotate and /upgrade: a DEK add must
            // not interleave with an in-flight AK rotation, which reads the keyring
            // then re-wraps it — an unlocked insert of a DEK wrapped under the OLD
            // AK would be stranded (permanently unrecoverable) after the flip.
            await txDb.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${userId})::bigint)`)
            // Proof-gated for parity with every other key/envelope mutator: a
            // hijacked trusted session without the signing key must not be able to
            // install a (mis-wrapped) primary DEK and lock the account out.
            if (!(await verifyChallengeSignature(txDb, userId, body.proof, 'rotate', caller.deviceId))) {
              throw new ForbiddenError('Invalid challenge proof')
            }
            await insertWrappedKey(txDb, { userId, keyId: body.keyId, wrappedKey: body.wrappedKey })
            if (body.setPrimary) {
              await setPrimaryKeyId(txDb, userId, body.keyId)
            }
          })

          return { key_id: body.keyId }
        },
        {
          auth: true,
          body: t.Object({
            keyId: t.String({ minLength: 1, maxLength: 64, pattern: '^[^:]+$' }),
            wrappedKey: t.String({ minLength: 1, maxLength: 500 }),
            setPrimary: t.Optional(t.Boolean()),
            proof: proofSchema,
          }),
        },
      )
      // Issue a single-use challenge nonce bound to (user, operation, caller
      // device). Pending devices may request one — a recovering device needs an
      // 'approve' challenge before it is trusted; the signature is the real gate.
      // Revoked devices are rejected by getCallerDevice.
      .get(
        '/encryption/challenge',
        async ({ query, request, set, user: sessionUser }) => {
          const userId = sessionUser!.id

          const operation = query.operation
          if (!challengeOperations.includes(operation as ChallengeOperation)) {
            set.status = 400
            return { error: 'Invalid operation' }
          }

          const caller = await getCallerDevice(database, userId, request)
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
      // Atomic AK rotation: replace every trusted device's envelope, re-wrap EVERY
      // key_id on the keyring under the new AK, replace canary + signing key +
      // kdf_salt, and bump key_version — one all-or-nothing transaction under the
      // per-user advisory lock (shared with envelope approval, upgrade and revoke,
      // so rotation can't race them). Gated by a 'rotate' challenge signature.
      .post(
        '/encryption/rotate',
        async ({ body, request, set, user: sessionUser }) => {
          const userId = sessionUser!.id
          const caller = await getCallerDevice(database, userId, request)
          if ('error' in caller) {
            set.status = caller.status
            return { error: caller.error }
          }
          if (!caller.device.trusted) {
            set.status = 403
            return { error: 'Only trusted devices can rotate keys' }
          }

          const orgEscrow = await getOrgEscrowKey(settings)

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
              )
              const trustedDeviceIds = await listTrustedDeviceIds(txDb, userId)
              assertEnvelopeCoverage(trustedDeviceIds, body.envelopes)

              for (const envelope of body.envelopes) {
                await upsertEnvelope(txDb, { deviceId: envelope.deviceId, userId, wrappedCk: envelope.wrappedCK })
              }
              for (const entry of body.wrappedKeys) {
                await updateWrappedKey(txDb, userId, entry.keyId, entry.wrappedKey)
              }
              await persistOrgEnvelope(txDb, orgEscrow, userId, body.orgEnvelope)
              await replaceEncryptionMetadata(txDb, {
                userId,
                canaryIv: body.canaryIv,
                canaryCtext: body.canaryCtext,
                signingPublicKey: body.signingPublicKey,
                kdfSalt: body.kdfSalt,
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
            wrappedKeys: t.Array(wrappedKeyEntrySchema, { minItems: 1, maxItems: 100 }),
            canaryIv: t.String({ maxLength: 500 }),
            canaryCtext: t.String({ maxLength: 500 }),
            signingPublicKey: t.String({ maxLength: 500 }),
            kdfSalt: t.String({ maxLength: 500 }),
            orgEnvelope: t.Optional(t.String({ maxLength: 500 })),
          }),
        },
      )
      // v1→v2 migration (WS1). The migrator absorbs the legacy CK into the keyring
      // as the reserved read-only `"v1"` slot AND mints a fresh primary DEK `"0"`,
      // registers the signing key + kdf_salt, re-encrypts the canary under the new
      // primary DEK, writes a new-AK envelope for every trusted device, and flips
      // scheme_version 1→2 atomically (CAS) as the LAST step — one all-or-nothing
      // transaction under the per-user advisory lock.
      //
      // Gated ONLY by the D1 CK-possession proof (the signing key does not exist
      // pre-flip, so this is the bootstrap op and is NOT signature-gated); an
      // 'upgrade' nonce is consumed for replay protection. A second concurrent
      // migrator loses the CAS and gets a 409.
      .post(
        '/encryption/upgrade',
        async ({ body, request, set, user: sessionUser }) => {
          const userId = sessionUser!.id
          const caller = await getCallerDevice(database, userId, request)
          if ('error' in caller) {
            set.status = caller.status
            return { error: caller.error }
          }
          if (!caller.device.trusted) {
            set.status = 403
            return { error: 'Only trusted devices can upgrade encryption' }
          }

          const orgEscrow = await getOrgEscrowKey(settings)

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
              const trustedDeviceIds = await listTrustedDeviceIds(txDb, userId)
              assertEnvelopeCoverage(trustedDeviceIds, body.envelopes)

              for (const entry of body.wrappedKeys) {
                await insertWrappedKey(txDb, { userId, keyId: entry.keyId, wrappedKey: entry.wrappedKey })
              }
              for (const envelope of body.envelopes) {
                await upsertEnvelope(txDb, { deviceId: envelope.deviceId, userId, wrappedCk: envelope.wrappedCK })
              }
              await persistOrgEnvelope(txDb, orgEscrow, userId, body.orgEnvelope)

              // Atomic last step: CAS scheme_version 1→2. A concurrent migrator that
              // already flipped leaves 0 rows → 409 (candidate AK never persisted).
              const flipped = await flipSchemeToV2(txDb, {
                userId,
                canaryIv: body.canaryIv,
                canaryCtext: body.canaryCtext,
                signingPublicKey: body.signingPublicKey,
                kdfSalt: body.kdfSalt,
                primaryKeyId: body.primaryKeyId,
              })
              if (!flipped) {
                throw new SchemeConflictError('Account already migrated to scheme v2')
              }
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
            wrappedKeys: t.Array(wrappedKeyEntrySchema, { minItems: 2, maxItems: 100 }),
            primaryKeyId: t.String({ minLength: 1, maxLength: 64, pattern: '^[^:]+$' }),
            canaryIv: t.String({ maxLength: 500 }),
            canaryCtext: t.String({ maxLength: 500 }),
            signingPublicKey: t.String({ maxLength: 500 }),
            kdfSalt: t.String({ maxLength: 500 }),
            orgEnvelope: t.Optional(t.String({ maxLength: 500 })),
          }),
        },
      )
      .post(
        '/devices/:deviceId/deny',
        async ({ params, body, request, set, user: sessionUser }) => {
          const userId = sessionUser!.id
          const callerDeviceId = request.headers.get('x-device-id')?.trim()

          if (!callerDeviceId) {
            set.status = 400
            return { error: 'X-Device-ID header is required' }
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
        async ({ params, body, request, set, user: sessionUser }) => {
          const userId = sessionUser!.id
          const callerDeviceId = request.headers.get('x-device-id')?.trim()

          if (!callerDeviceId) {
            set.status = 400
            return { error: 'X-Device-ID header is required' }
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
      .post(
        '/devices/me/cancel-pending',
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

          if (device.trusted || device.revokedAt != null) {
            set.status = 409
            return { error: 'Device is not pending approval' }
          }

          await denyDevice(database, deviceId, userId)
          set.status = 204
        },
        { auth: true },
      )
  )
}
