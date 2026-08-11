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
  getEnvelopeByDeviceId,
  hasEnvelopesForUser,
  upsertEnvelope,
  deleteAllEnvelopesForUser,
  getEncryptionMetadata,
  insertEncryptionMetadataIfNotExists,
  replaceEncryptionMetadata,
  bumpKeyVersion,
  setPrimaryKeyId,
  deleteEncryptionMetadata,
  getWrappedKey,
  listWrappedKeys,
  insertWrappedKey,
  updateWrappedKey,
  deleteAllWrappedKeysForUser,
  issueChallengeNonce,
  listTrustedDeviceIds,
  revokeDeviceSessions,
} from '@/dal'
import type { db as DbType } from '@/db/client'
import { BadRequestError, ForbiddenError } from '@/errors/http-errors'
import { verifyChallengeProof } from '@/lib/canary'
import { type ChallengeOperation, challengeNonceTtlMs, challengeOperations, initialKeyId } from '@shared/e2ee-types'
import { sql } from 'drizzle-orm'
import { Elysia, t } from 'elysia'

const maxDevicesPerUser = 10

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
 * Encryption API routes for device registration, envelope management,
 * the wrapped-DEK keyring, challenge-response, and AK rotation.
 * All routes require authentication via session.
 */
export const createEncryptionRoutes = (auth: Auth, database: typeof DbType) =>
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
    // Store a device envelope. The `wrappedCK` field carries the ACCOUNT KEY
    // (AK) in v2 — the historical name is kept to avoid wire churn.
    //
    // Three paths (A8):
    // 1. First-device bootstrap — no encryption metadata exists, caller==target:
    //    requires the full atomic v2 setup payload (canary + signing key +
    //    kdf salt + initial wrapped keyring); everything is created in one
    //    transaction so half-configured accounts cannot exist.
    // 2. Self-recovery / re-key — metadata exists, caller==target: requires a
    //    ChallengeProof (operation 'approve'). A recovering device CAN produce
    //    it: mnemonic → AK → fetch wrapped DEK → decrypt canary → derive
    //    signing key.
    // 3. Approval — metadata exists, caller!=target: requires the proof AND a
    //    trusted caller (defense-in-depth).
    //
    // If metadata exists, bootstrap is unreachable — a v1 account (NULL
    // signing key) fails proof verification closed and must go through
    // POST /encryption/reset; an active v2 account has no static-secret
    // override anymore.
    .post(
      '/devices/:deviceId/envelope',
      async ({ params, body, request, set, user: sessionUser }) => {
        const userId = sessionUser!.id
        const { deviceId } = params
        const { wrappedCK, proof, canaryIv, canaryCtext, signingPublicKey, kdfSalt, wrappedKeys } = body

        // Pre-transaction check: fast-path rejection for missing/wrong-user/revoked devices
        // without starting a transaction. Re-checked inside tx to close race window.
        const device = await getDeviceById(database, deviceId)
        if (!device || device.userId !== userId) {
          set.status = 404
          return { error: 'Device not found' }
        }

        if (device.revokedAt != null) {
          set.status = 403
          return { error: 'Device has been revoked' }
        }

        // Reject if target device is already trusted (prevents envelope overwrite attacks)
        // Only the device itself can re-key its own envelope
        const callerDeviceId = request.headers.get('x-device-id')?.trim()
        if (!callerDeviceId) {
          set.status = 400
          return { error: 'X-Device-ID header is required' }
        }

        if (device.trusted && callerDeviceId !== deviceId) {
          set.status = 409
          return { error: 'Cannot overwrite envelope of an already-trusted device' }
        }

        // Use a transaction for atomicity (prevents race conditions on first-device bootstrap)
        try {
          await database.transaction(async (tx) => {
            const txDb = tx as unknown as typeof database

            // Serialize concurrent device approvals for this user to prevent cap bypass
            // (Finding F): without this, two concurrent envelope txs both see count<MAX
            // and both promote pending devices, exceeding the cap. The advisory lock
            // auto-releases on commit/rollback. It also serializes against POST /rotate
            // and revoke, which take the same lock.
            await txDb.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${userId})::bigint)`)

            const metadata = await getEncryptionMetadata(txDb, userId)

            if (!metadata) {
              // ── Path 1: first-device bootstrap (atomic v2 setup) ──
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
                throw new BadRequestError(`First device bootstrap requires a wrapped key for key_id '${initialKeyId}'`)
              }
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
              // ── Paths 2 + 3: metadata exists — every path requires a proof.
              // v1 metadata (NULL signing_public_key) fails verification closed;
              // the beta reset (POST /encryption/reset) is its only way forward.
              if (!proof) {
                throw new ForbiddenError('Challenge proof required for device approval')
              }
              if (!(await verifyChallengeProof(txDb, userId, proof, 'approve', callerDeviceId))) {
                throw new ForbiddenError('Invalid challenge proof')
              }

              if (callerDeviceId !== deviceId) {
                // Path 3: approving another device — caller-trust check (defense-in-depth)
                const callerDevice = await getDeviceById(txDb, callerDeviceId)
                if (!callerDevice || callerDevice.userId !== userId) {
                  throw new ForbiddenError('Caller device not found')
                }
                if (!callerDevice.trusted) {
                  throw new ForbiddenError('Only trusted devices can store envelopes')
                }
              }
              // Path 2 (caller==target): self-recovery or envelope re-key — the
              // proof itself is the gate (only key possession can produce it).
            }

            // Re-check target device inside transaction to close race window
            const targetDevice = await getDeviceById(txDb, deviceId)
            if (!targetDevice || targetDevice.revokedAt != null) {
              throw new ForbiddenError('Device has been revoked')
            }

            // Store envelope (carries the AK)
            await upsertEnvelope(txDb, {
              deviceId,
              userId,
              wrappedCk: wrappedCK,
            })

            // Approval-only state transition: cap check + markDeviceTrusted only run when
            // transitioning untrusted → trusted. For re-key (already-trusted devices rotating
            // envelopes), the upsertEnvelope above is the only state change needed. Running
            // markDeviceTrusted on an already-trusted device matches 0 rows (its WHERE requires
            // approvalPending=true) and would falsely throw 'Device has been revoked'.
            if (!targetDevice.trusted) {
              // registerDevice checks the cap, but pending devices don't count toward it. Without
              // this guard, a user could register N+1 pending devices and approve them all,
              // exceeding maxDevicesPerUser.
              const activeCount = await countActiveDevices(txDb, userId)
              if (activeCount >= maxDevicesPerUser) {
                throw new ForbiddenError('Device limit reached — revoke an existing device first')
              }

              // Mark device as trusted. Check rows returned to detect a concurrent revoke
              // that committed between the in-tx target read above and this UPDATE.
              const updated = await markDeviceTrusted(txDb, deviceId, userId)
              if (updated.length === 0) {
                throw new ForbiddenError('Device has been revoked')
              }
            }
          })
        } catch (err) {
          if (err instanceof BadRequestError) {
            set.status = 400
            return { error: err.message }
          }
          if (err instanceof ForbiddenError) {
            set.status = 403
            return { error: err.message }
          }
          throw err
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

        // Verify device belongs to this user
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
    // Encryption metadata (still at /encryption/canary — the poll clients
    // already do at unlock). Returns the shared EncryptionMetadataResponse
    // DTO; `key_version`/`primary_key_id` ride along so devices detect AK/DEK
    // rotations by polling (decision 3 in the implementation plan).
    // `signing_public_key`/`kdf_salt` are null for v1 rows — clients use that
    // to detect a v1 account that needs the beta reset (G3).
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
        }
      },
      { auth: true },
    )
    // Wrapped-DEK keyring (A3). ACCESS RULE — deliberate deviation from the
    // one-line plan text ("restricted to a trusted device"): any
    // authenticated, NON-REVOKED device of the user may read wrapped keys,
    // including pending ones. A recovering device must fetch the wrapped DEK
    // BEFORE it is trusted (mnemonic → AK → unwrap DEK → decrypt canary →
    // derive signing key → prove possession). The AES-KW wrapping under the
    // AK is the real cryptographic gate — a wrapped key is useless without
    // the AK. Revoked devices are rejected (403).
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
    // (insertWrappedKey is ON CONFLICT DO NOTHING) — this route can never
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
        }),
      },
    )
    // Issue a single-use challenge nonce (A4) bound to (user, operation,
    // caller device). Pending devices may request one — a recovering device
    // needs an 'approve' challenge before it is trusted; the signature is the
    // real gate. Revoked devices are rejected by getCallerDevice.
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
    // Atomic AK rotation (A5): replace every trusted device's envelope,
    // re-wrap EVERY key_id on the keyring under the new AK, replace canary +
    // signing key + kdf_salt, and bump key_version — one all-or-nothing
    // transaction under the per-user advisory lock (shared with envelope
    // approval and revoke, so rotation can't race them).
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

        try {
          const keyVersion = await database.transaction(async (tx) => {
            const txDb = tx as unknown as typeof database
            await txDb.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${userId})::bigint)`)

            // Verify inside the tx so nonce consumption serializes under the lock
            // (concurrent rotates: the second one fails on its own nonce or on
            // coverage validation against the already-rotated state).
            if (!(await verifyChallengeProof(txDb, userId, body.proof, 'rotate', caller.deviceId))) {
              throw new ForbiddenError('Invalid challenge proof')
            }

            // The FULL keyring must be re-wrapped: re-wrapping only a subset
            // strands the missing key_ids under the discarded old AK — permanent
            // data loss. Unknown key_ids are rejected too (rotation never mints).
            const existingKeys = await listWrappedKeys(txDb, userId)
            const existingKeyIds = new Set(existingKeys.map((key) => key.keyId))
            const submittedKeyIds = new Set(body.wrappedKeys.map((entry) => entry.keyId))
            if (submittedKeyIds.size !== body.wrappedKeys.length) {
              throw new BadRequestError('Duplicate key_id in wrappedKeys')
            }
            const missingKeyIds = [...existingKeyIds].filter((keyId) => !submittedKeyIds.has(keyId))
            if (missingKeyIds.length > 0) {
              throw new BadRequestError(
                `wrappedKeys must cover every existing key_id — missing: ${missingKeyIds.join(', ')}`,
              )
            }
            const unknownKeyIds = [...submittedKeyIds].filter((keyId) => !existingKeyIds.has(keyId))
            if (unknownKeyIds.length > 0) {
              throw new BadRequestError(`wrappedKeys contains unknown key_ids: ${unknownKeyIds.join(', ')}`)
            }

            // Every currently-trusted, non-revoked device needs a new-AK envelope
            // (a missing one would be locked out); an envelope for any OTHER
            // device would hand the new AK to a revoked/pending device.
            const trustedDeviceIds = new Set(await listTrustedDeviceIds(txDb, userId))
            const submittedDeviceIds = new Set(body.envelopes.map((envelope) => envelope.deviceId))
            if (submittedDeviceIds.size !== body.envelopes.length) {
              throw new BadRequestError('Duplicate deviceId in envelopes')
            }
            const missingDeviceIds = [...trustedDeviceIds].filter((deviceId) => !submittedDeviceIds.has(deviceId))
            if (missingDeviceIds.length > 0) {
              throw new BadRequestError(
                `envelopes must cover every trusted device — missing: ${missingDeviceIds.join(', ')}`,
              )
            }
            const unknownDeviceIds = [...submittedDeviceIds].filter((deviceId) => !trustedDeviceIds.has(deviceId))
            if (unknownDeviceIds.length > 0) {
              throw new BadRequestError(`envelopes contains non-trusted devices: ${unknownDeviceIds.join(', ')}`)
            }

            for (const envelope of body.envelopes) {
              await upsertEnvelope(txDb, { deviceId: envelope.deviceId, userId, wrappedCk: envelope.wrappedCK })
            }
            for (const entry of body.wrappedKeys) {
              await updateWrappedKey(txDb, userId, entry.keyId, entry.wrappedKey)
            }
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
          if (err instanceof BadRequestError) {
            set.status = 400
            return { error: err.message }
          }
          if (err instanceof ForbiddenError) {
            set.status = 403
            return { error: err.message }
          }
          throw err
        }
      },
      {
        auth: true,
        body: t.Object({
          proof: proofSchema,
          envelopes: t.Array(
            t.Object({ deviceId: t.String({ maxLength: 36 }), wrappedCK: t.String({ maxLength: 2200 }) }),
            { minItems: 1, maxItems: maxDevicesPerUser },
          ),
          wrappedKeys: t.Array(wrappedKeyEntrySchema, { minItems: 1, maxItems: 100 }),
          canaryIv: t.String({ maxLength: 500 }),
          canaryCtext: t.String({ maxLength: 500 }),
          signingPublicKey: t.String({ maxLength: 500 }),
          kdfSalt: t.String({ maxLength: 500 }),
        }),
      },
    )
    // v1 beta reset (A9): wipe v1 encryption state so the account can run a
    // fresh v2 setup. Allowed ONLY for v1 accounts (metadata exists AND
    // signing_public_key IS NULL); v2 accounts get 409.
    //
    // Why no proof: the v1 proof mechanism (static canary secret hash) no
    // longer exists — its column was dropped — and v1 ciphertext is abandoned
    // by design (decision 5 in the implementation plan: no migration, no
    // re-encryption; v1 no-AAD data is intentionally left undecryptable).
    // Deleting the metadata/envelopes grants no plaintext access; it only
    // forces a fresh v2 setup.
    .post(
      '/encryption/reset',
      async ({ set, user: sessionUser }) => {
        const userId = sessionUser!.id

        try {
          await database.transaction(async (tx) => {
            const txDb = tx as unknown as typeof database
            await txDb.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${userId})::bigint)`)

            const metadata = await getEncryptionMetadata(txDb, userId)
            if (!metadata) {
              throw new BadRequestError('Encryption not set up')
            }
            if (metadata.signingPublicKey != null) {
              throw new ForbiddenError('v2 account — reset not allowed')
            }

            await deleteEncryptionMetadata(txDb, userId)
            await deleteAllEnvelopesForUser(txDb, userId)
            // A v1 account should have no wrapped_keys rows — deleted for completeness.
            await deleteAllWrappedKeysForUser(txDb, userId)
          })
        } catch (err) {
          if (err instanceof BadRequestError) {
            set.status = 404
            return { error: err.message }
          }
          if (err instanceof ForbiddenError) {
            set.status = 409
            return { error: err.message }
          }
          throw err
        }

        set.status = 204
      },
      { auth: true },
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
        const validProof = await verifyChallengeProof(database, userId, body.proof, 'deny', callerDeviceId)
        if (!validProof) {
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
        body: t.Object({
          proof: proofSchema,
        }),
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
        // holding the account signing key can sign the challenge. Mirrors deny.
        const validProof = await verifyChallengeProof(database, userId, body.proof, 'node-id', callerDeviceId)
        if (!validProof) {
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
    // to — not an arbitrary target the way the challenge-gated POST /devices/:deviceId/node-id can.
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
