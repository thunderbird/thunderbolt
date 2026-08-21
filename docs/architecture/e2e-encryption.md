# End-to-End Encryption

> ⚠️ End-to-end encryption is in **Preview**. It has not yet undergone a cryptography audit and is subject to further refinements.

Thunderbolt supports optional zero-knowledge end-to-end encryption: all user data is encrypted client-side before sync and decrypted client-side after download. The server stores only ciphertext and wrapped keys — it cannot read user data even if compelled or breached.

This document describes **E2EE v2** — the AK/DEK key hierarchy with hybrid post-quantum device envelopes, AAD-bound versioned ciphertext, ECDSA challenge-response device management, and the **data-preserving v1 → v2 migration** (absorb + permanent dual-read). For the sync pipeline integration, see [powersync-sync-middleware.md](powersync-sync-middleware.md).

---

## Configuration

E2EE is **disabled by default**. The backend is the single source of truth:

| Variable       | Where          | Default | Effect when enabled                                                                                                  |
| -------------- | -------------- | ------- | -------------------------------------------------------------------------------------------------------------------- |
| `E2EE_ENABLED` | Backend `.env` | `false` | Requires device trust flow before allowing sync; frontend encrypts/decrypts data, shows setup wizard, generates keys |

```env
# Backend (backend/.env)
E2EE_ENABLED=true
```

The frontend reads this flag from the backend's `GET /v1/config` endpoint at app initialization and caches it in `localStorage` for offline use. No frontend environment variable is needed.

When disabled (default), sync works without encryption — no setup wizard, no key generation, no recovery key. The backend auto-trusts devices and skips the envelope flow.

**Frontend control point:** `isEncryptionEnabled()` in `src/db/encryption/config.ts` reads the cached flag from `localStorage`. The companion `needsSyncSetupWizard()` helper combines the encryption-enabled check with an **AK-plus-a-wrapped-DEK-exists** check (v1 checked only for a single CK) — it returns `true` only when E2EE is on and the v2 key hierarchy is not yet set up locally. Its boolean contract is unchanged, so sign-in and the sync toggle use it exactly as before.

**Backend control point:** `e2eeEnabled` in `backend/src/config/settings.ts`.

### Migration gate (`MIN_APP_VERSION`)

The v1 → v2 rollout is a **hard cutover** guarded by the app-version gate (`createAppVersionMiddleware`, mounted before auth in `backend/src/index.ts`). When `MIN_APP_VERSION` is set, every non-exempt `/v1` request from a below-minimum client (including `GET /v1/powersync/token`) is rejected with **426 Upgrade Required** — fail-closed, so a missing `X-App-Version` is also rejected. This prevents a live v1 client from syncing a flipped account with stale code. See [powersync-account-devices.md](powersync-account-devices.md) and the migration section below.

---

## Key Concepts

| Concept                  | Description                                                                                                                                                                     |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Device key pair**      | Each device generates an **ECDH P-256** key pair and an **ML-KEM-768** key pair. Private keys never leave the device. The ML-KEM secret is encrypted at rest (self-ECDH → HKDF). |
| **Account Key (AK)**     | An **AES-256** key with `wrapKey`/`unwrapKey` usages **only** — it never encrypts data; it is pure access control over the keyring. Randomly generated, never derived, so it can be rotated without the user's phrase. |
| **DEK keyring**          | Versioned **AES-256-GCM** Data Encryption Keys (`key_id` `"0"`, `"1"`, …). Exactly one is `primary` (encrypts new writes); older DEKs are retained forever for reads.          |
| **`"v1"` slot**          | A reserved, read-only DEK slot holding the **absorbed legacy CK** from a migrated account. Decrypts legacy `__enc:<iv>:<ct>` rows (no AAD) forever. Never encrypts. See migration. |
| **Device envelope**      | The **AK** wrapped for one device via a hybrid ECDH + ML-KEM envelope. (The stored column is still named `wrapped_ck` for wire compatibility — it carries the AK.)             |
| **Recovery key**         | The 256-bit recovery **seed** encoded as a **24-word BIP-39 mnemonic**. Shown once at setup/migration/phrase change. `mnemonic → seed → KDF → recovery keypair`.               |
| **Recovery slot**        | The recovery phrase as a **virtual device**: the seed-derived hybrid PUBLIC keys plus the AK wrapped to them, stored on `encryption_metadata`. Because wrapping needs only the public half, any trusted device can re-anchor the slot to a new AK — which is why revocation no longer invalidates the phrase. |
| **Canary**               | A known prefix + secret encrypted under the **primary DEK** with `canaryAAD(userId, keyId)`. Verifies key material at unlock and seeds the challenge-response signing keypair.  |
| **Challenge-response**   | An ECDSA P-256 keypair **deterministically derived from the canary secret**. Every post-flip trust op (approve/deny/revoke/rotate/recover) is signature-gated by a single-use server nonce. |

## Key Hierarchy

Two tiers: the AK gates the keyring; the primary DEK encrypts data. AK rotation and DEK rotation both re-encrypt **zero** data rows.

```
24-word BIP-39 recovery seed
        │  PBKDF2-SHA512, 600k iters, per-account kdf_salt
        ▼
recovery keypair (ECDH-P256 + ML-KEM-768) — public half stored server-side
        ▲  hybrid envelope, alongside one per device
        │
       AK (Account Key, AES-256, wrapKey/unwrapKey only — randomly generated)
        │  AES-KW wraps ▼
   DEK keyring (versioned, AES-256-GCM)
        ├─ key_id "0"   (primary — encrypts new writes)
        ├─ key_id "1"…  (older DEK versions — retained for reads)
        └─ key_id "v1"  (reserved, read-only: the absorbed legacy CK)
        │  AES-256-GCM + AAD encrypts ▼
      column data
```

Each device unwraps its own envelope to arrive at the same AK, then unwraps the wrapped-DEK keyring under that AK. The recovery slot is one more envelope over the same AK, so entering the phrase lands on exactly the same key hierarchy a device does.

## Wire Format

New (v2) encrypted column values are written with a version tag, the `key_id`, and AAD bound to the row context (never stored on the wire):

```
__enc:v2:<key_id>:<iv-base64>:<ciphertext-base64>      AAD = table ‖ column ‖ row_id ‖ key_id
```

Legacy (v1) values from before migration are read **in place, forever** and carry no version, no `key_id`, and no AAD:

```
__enc:<iv-base64>:<ciphertext-base64>                  decrypted via the "v1" DEK slot, NO AAD
```

`isV2EncryptedValue` in `src/db/encryption/wire-format.ts` is the single v1/v2 classifier. The codec **reads both** formats but **writes only v2** (dual-read, write-v2). `encode()` always encrypts (no `__enc:`-prefixed idempotency bypass); `decode()` dispatches on the wire version. The download/upload middleware read which columns to encrypt from `encryptedColumnsMap` in [src/db/encryption/config.ts](../../src/db/encryption/config.ts); decode stays prefix-gated so a stale client still decodes columns it doesn't know are encrypted.

## User Flows

| Scenario              | What happens                                                                                                                                                     |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **First device**      | Enable sync → generate a random AK + primary DEK `"0"` → wrap AK for this device and for the seed-derived recovery keypair → create canary + signing keypair → recovery key shown once. |
| **Additional device** | New device generates keys → waits for approval → a trusted device rewraps the AK for it (`approve`, signature-gated) → new device unwraps AK and stages the keyring. |
| **Returning device**  | Key pair present, AK missing → fetch own envelope → unwrap AK → stage keyring → sync resumes.                                                                    |
| **Recovery key**      | Enter 24-word phrase → seed → fetch `kdf_salt` → derive the recovery keypair → reject immediately if its public half doesn't match the stored one → unwrap the AK from `recovery_wrapped_ak` → verify canary → unwrap keyring (incl. `"v1"`) → new envelope for this device. |
| **Change phrase**     | `changeRecoveryPhrase`: new random AK **and** a new seed; re-wrap the **entire** keyring under the new AK; re-issue every device envelope; re-anchor the recovery slot to the new phrase; new canary + signing key; `key_version++`. 0 rows re-encrypted. The new phrase is shown once. |
| **Revoke device**     | Delete envelope + revoke sessions, then **rotate both AK and DEK** so the removed device is locked out of future keyring and data. The AK rotation re-anchors the recovery slot to the **existing** recovery public keys, so the rotation is silent and the user's phrase keeps working. |
| **Migrate (v1 → v2)** | See below — seamless, data-preserving, never a reset.                                                                                                            |
| **Sign out**          | All local keys cleared (dynamic DEK ids enumerated, not a static list) → next sign-in is a new device.                                                            |

## Migration (v1 → v2): absorb + permanent dual-read

Existing v1 accounts (single CK) migrate to the v2 keyring with **zero data loss** and no re-upload of existing rows:

1. **Absorb.** The first trusted, CK-holding device ("the migrator") unwraps the legacy CK from its v1 envelope (`unwrapLegacyCK`, sharing the same hybrid-envelope derivation) and inserts it into the keyring as the reserved, read-only **`"v1"` slot**.
2. **Mint + flip.** It mints a fresh primary DEK `"0"`, generates a new random AK, mints a new recovery phrase, wraps the keyring (both `"0"` and `"v1"`), writes an envelope for every trusted device **and for the new recovery keypair**, registers the signing key + `kdf_salt`, and calls `POST /v1/encryption/upgrade`. The server verifies a **CK-possession proof** (the migrator recovers `canarySecret` by a no-AAD CK decrypt of the stored canary; the server checks `hash(canarySecret) == canary_secret_hash`), validates envelope + key coverage (a keyring **must** include both `"0"` and `"v1"`), and **CAS-flips `scheme_version` 1 → 2** as the atomic last step. The recovery phrase is shown **only on HTTP 200**.
3. **Concurrent migrators** resolve by that CAS: one wins; a loser gets **409** and falls through to the follower path (fetches the winner's envelope). Nothing local is persisted before the 200, so a loser is cleanly re-classified.
4. **Followers** (`scheme_version == 2`, no local AK) fetch their envelope, unwrap the AK, stage the keyring (including the `"v1"` slot — followers never absorb), and run a continuity check that decrypts a synced legacy row via the `"v1"` slot.
5. **Dual-read is permanent.** Legacy `__enc:<iv>:<ct>` rows are decoded in place via the `"v1"` slot forever; there is no bulk re-upload and no v1-encode path. New writes are v2 from the first flip.

The `MIN_APP_VERSION` gate is set in the merge deploy so it is live before any client can flip an account, closing the window where a live v1 client could read a flipped account.

## Adding a New Encrypted Column

Add the table and column name to `encryptedColumnsMap` in [src/db/encryption/config.ts](../../src/db/encryption/config.ts). The middleware handles every column in the map automatically — download decryption and upload encryption (which binds AAD from the row context).

## Key Files

| File                                | Role                                                                        |
| ----------------------------------- | --------------------------------------------------------------------------- |
| `shared/e2ee-types.ts`              | Cross-boundary contracts: wire prefixes, `encodeAAD`/`canaryAAD`, challenge payload, DTOs |
| `src/crypto/primitives.ts`          | AK/DEK primitives, hybrid AK wrap/unwrap, `unwrapLegacyCK`, AES-256-GCM + AAD |
| `src/crypto/key-storage.ts`         | IndexedDB key storage (AK + dynamic `thunderbolt_dek_{keyId}`, ML-KEM at rest) |
| `src/crypto/canary.ts`              | Canary create/verify, deterministic ECDSA signing keypair, `recoverCanarySecretV1` |
| `src/crypto/recovery-key.ts`        | Recovery seed ↔ BIP-39 mnemonic, `deriveRecoveryKeyPairFromSeed` (KDF)       |
| `src/db/encryption/wire-format.ts`  | v1/v2 wire parse/format + `isV2EncryptedValue` classifier                    |
| `src/db/encryption/config.ts`       | Encrypted columns map (single source of truth)                              |
| `src/db/encryption/codec.ts`        | Dual-read AES-GCM codec with a key_id-indexed keyring cache                  |
| `src/services/encryption.ts`        | Service layer: setup, approve, recover, rotate, migrator + follower          |
| `backend/src/api/encryption.ts`     | Backend API: keys, challenge, rotate, upgrade                                |
| `backend/src/db/encryption-schema.ts` | Server-only tables: `encryption_metadata`, `wrapped_keys`, `challenge_nonces`, `envelopes` |
| `backend/src/lib/canary.ts`         | ECDSA challenge verification + `/upgrade` possession-proof check             |

## Sync Pipeline Integration

Encryption is implemented as a PowerSync transform-middleware. On **Chrome/Edge/Firefox** it runs inside a custom SharedWorker so keys stay in one place across tabs; on **Safari and Tauri** it runs on the main thread. Because the worker has key material but no auth token, the main thread pre-stages the wrapped-DEK keyring (including `"v1"`) into IndexedDB on unlock and after rotations; on an unknown `key_id` the worker signals the main thread to refresh the AK / fetch the missing DEK rather than failing open. See [Multi-Device Sync](./multi-device-sync.md#two-sync-paths) and [powersync-sync-middleware.md](./powersync-sync-middleware.md).

## Testing

The end-to-end suite lives in `e2e/e2ee/` and runs against a real Postgres + PowerSync service:

```bash
bash scripts/run-e2ee-powersync.sh                       # full suite
bash scripts/run-e2ee-powersync.sh migration.spec.ts     # one spec
```

The script boots `powersync-service/docker-compose.yml` on dedicated ports (5434/8081) and runs `playwright.e2ee.config.ts`. `migration.spec.ts` seeds a real legacy v1 account (hybrid CK envelopes + `__enc:<iv>:<ct>` rows) and proves zero data loss across the migrator, a later-joining follower, and a fresh recovery, plus the concurrent-migrator CAS and the below-min 426 guard.
