# End-to-End Encryption

> ⚠️ End-to-end encryption is in **Preview**. It has not yet undergone a cryptography audit and is subject to further refinements.

Thunderbolt supports optional zero-knowledge end-to-end encryption: all user data is encrypted client-side before sync and decrypted client-side after download. The server stores only ciphertext and wrapped keys — it cannot read user data even if compelled or breached.

This document describes the **v2** key hierarchy (AK + DEK). For the design rationale and the v1→v2 problem analysis it fixes, see the [E2EE v2 spec](https://github.com/thunderbird/thunderbolt-spec/blob/spec/e2ee-v2/specs/e2ee-v2.md). For the sync-pipeline integration, see [powersync-sync-middleware.md](powersync-sync-middleware.md).

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

When disabled (default), sync works without encryption — no setup wizard, no key generation, no recovery key. The backend auto-trusts devices and skips the envelope flow. The encryption API endpoints remain available but are not called.

**Frontend control point:** `isEncryptionEnabled()` in `src/db/encryption/config.ts` reads the cached flag from `localStorage`. The companion `needsSyncSetupWizard()` helper combines the encryption-enabled check with a **key-exists** check — it returns `true` only when E2EE is on and the account key + primary DEK have not been set up on this device yet (in v1 this checked for the Content Key). Both the sign-in flow and the sync toggle use this helper to decide whether to show the setup wizard or enable sync directly.

**Backend control point:** `e2eeEnabled` in `backend/src/config/settings.ts`. When `false`, `validateDeviceForSync()` skips the trust check and `issuePowerSyncToken()` auto-trusts devices on upsert.

---

## Key Concepts

v2 splits the single v1 Content Key into two tiers: an **Account Key** that controls access and a versioned **Data Encryption Key** keyring that encrypts data. This makes key rotation and device revocation cost **zero data re-encryption**.

| Concept                    | Description                                                                                                                                                          |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Device key pair**        | Each device generates an **ECDH P-256** key pair and an **ML-KEM-768** key pair when sync is enabled. Private keys never leave the device.                          |
| **Account Key (AK)**       | An **AES-256** key with WebCrypto usages `wrapKey`/`unwrapKey` **only** — it cannot encrypt data. Controls access: it wraps the DEK keyring. Identical across a user's devices. |
| **DEK keyring**            | **AES-256-GCM** keys (usages `encrypt`/`decrypt`) that actually encrypt data. A versioned keyring: exactly one DEK is **primary** (encrypts all new writes), identified by a `key_id`. Old versions are retained forever so old values still decrypt. |
| **Device envelope**        | The AK wrapped using hybrid ECDH + ML-KEM for a specific device. Only that device's private keys can unwrap it. (The server column is still named `wrappedCk` for wire compatibility; it now carries the AK.) |
| **Recovery key**           | A 24-word **BIP-39 mnemonic** that encodes a random 256-bit **seed**. The AK is *derived* from the seed via a KDF (PBKDF2-SHA512, 600k iterations) — the mnemonic is not the AK itself. Shown once at setup. |
| **Canary**                 | A fixed plaintext encrypted with the **primary DEK**, stored server-side. Used to verify a recovery key and to derive the challenge-response signing key.            |
| **Challenge-response**     | An **ECDSA P-256** signing keypair, deterministically derived from the canary secret. The server stores only the public key and issues single-use nonces; clients prove key possession by signing a nonce. Replaces the v1 static canary secret. |

## Key Hierarchy

The recovery seed and every device envelope resolve to the **same AK**. The AK unwraps the **DEK keyring**; the primary DEK encrypts new data, and each stored value carries the `key_id` of the DEK that wrote it, so old values keep decrypting under their original key.

```
              recovery seed (BIP-39)          device 1        device 2
                     │ KDF                     │ unwrap        │ unwrap
                     ▼                         ▼ envelope      ▼ envelope
                    ┌──────────────────────────────────────────────────┐
                    │                        AK                         │
                    │        (Account Key — wrapKey / unwrapKey)        │
                    └───────────────────────────┬──────────────────────┘
                                    unwraps each wrapped DEK
                    ┌───────────────────┬───────────────────┬──────────┐
                    ▼                   ▼                   ▼
             ┌────────────┐      ┌────────────┐      ┌────────────┐
             │ DEK key_id 0│      │ DEK key_id 1│      │ DEK key_id  │
             │  (primary)  │      │  (retained) │      │  "ws1" …    │
             └──────┬──────┘      └──────┬──────┘      └──────┬──────┘
          encrypt NEW writes      decrypt old key_id 1   future: workspace
          + decrypt key_id 0      values only            / shared-resource DEKs
```

## Wire Format

Encrypted column values on the wire are written as:

```
__enc:v2:<key_id>:<iv-base64>:<ciphertext-base64>
```

| Segment      | Purpose                                                                                                    |
| ------------ | ---------------------------------------------------------------------------------------------------------- |
| `__enc:`     | Sentinel — distinguishes encrypted values from plaintext. Detection only.                                  |
| `v2`         | Version — the codec dispatches decrypt logic by version, so a future `v3` decoder can coexist with old data. |
| `key_id`     | Which DEK encrypted this value (`"0"`, `"1"`, …; workspace DEKs get ids like `"ws1"`). Never contains `:`. |
| `iv`         | 12-byte random IV for AES-256-GCM (fresh per encrypt).                                                      |
| `ciphertext` | AES-256-GCM output (includes the auth tag).                                                                 |

The wire format, its parser, and the AAD/challenge encoders live in `shared/e2ee-types.ts` — the single source of truth imported by **both** the frontend and the backend so the two sides can never diverge. Wire-format parsing/formatting is in `src/db/encryption/wire-format.ts`.

### AAD binding

Every encrypt and decrypt is bound to its row context via AES-GCM Additional Authenticated Data, built by the shared `encodeAAD(table, column, rowId, keyId)` helper:

```
AAD = table_name ␟ column_name ␟ row_id ␟ key_id      (␟ = U+001F unit separator)
```

The AAD is **never stored on the wire** — it is reconstructed at decode time from the row context plus the parsed `key_id`. Moving a ciphertext to a different table, column, row, or `key_id` causes AES-GCM authentication to fail, so the server cannot substitute or relocate ciphertexts.

The upload encoder builds AAD from `{table: op.type, column, rowId: op.id}`; the download middleware rebuilds the identical tuple from the OplogEntry's `object_type` / JSON key / `object_id`. `encode()` **always** encrypts (the v1 `__enc:` prefix bypass is gone); `decode()` uses the prefix only to tell ciphertext from plaintext.

## Challenge-Response (device management)

Trust-sensitive operations (approve, deny, revoke, rotate, and P2P `node-id` attestation) are gated by an asymmetric challenge-response instead of a replayable static secret:

1. The client `GET /v1/encryption/challenge?operation=<op>` → server issues a single-use `{nonce, expiresAt}` (~5 min TTL) bound to `userId + operation + deviceId`.
2. The client decrypts the canary with the primary DEK → recovers the canary secret → derives its ECDSA P-256 signing key: `signing_seed = HKDF(canarySecret, "thunderbolt-signing-v1")`.
3. The client signs `encodeChallengePayload(nonce ␟ operation ␟ deviceId)` and sends `{signature, nonce, operation, deviceId}`.
4. The server **consumes the nonce first** (one atomic `UPDATE … WHERE consumed=false AND expires_at>now()` — no replay/expiry window), checks the operation/device/user binding, then verifies the signature against the stored `signing_public_key`.

The server stores only the public verification key — a compromised server can verify legitimate proofs but cannot forge new ones. The signing keypair rotates automatically whenever the canary is replaced (AK rotation).

## Rotation & Revocation

Both layers rotate without re-encrypting any data:

- **AK rotation** (recovery-key change, device revocation, hygiene): generate a new seed → derive a new AK → **re-wrap the entire DEK keyring** under the new AK → re-issue every trusted device's envelope → replace the canary + signing key + `kdf_salt` → increment `key_version`. Submitted atomically via `POST /v1/encryption/rotate` under a per-user advisory lock; the endpoint rejects a payload that doesn't cover **every** existing `key_id` and **every** trusted device. **0 rows re-encrypted.**
- **DEK rotation** (forward secrecy over future writes): mint a new DEK at the next `key_id`, wrap it with the current AK, `POST /v1/encryption/keys`, mark it primary. Old DEKs stay on the keyring. **0 rows re-encrypted.**
- **Device revocation** rotates **both**: AK (locks the removed device out of the keyring) and DEK (so post-revocation writes use a `key_id` it never held).

## Rotation Propagation (polling + lazy-fetch)

Devices detect rotations by **polling**, not by a synced table. `key_version` and `primary_key_id` ride along on the `GET /v1/encryption/canary` metadata response the client already fetches at unlock (`encryption_metadata` is server-only, so no PowerSync sync-rule changes).

Because decode runs in the **SharedWorker** — which has IndexedDB but no auth token, so it cannot fetch keys — the read path self-heals through a main-thread responder:

- The main thread **pre-stages** all wrapped DEKs into IndexedDB on unlock and after any local rotation.
- On an **unknown `key_id`**, or a DEK that **won't unwrap** under the current AK (the post-revocation case, where the new DEK is wrapped under a new AK), the worker posts a `key-request` on the `thunderbolt-keys-sync` `BroadcastChannel`. The main thread responds by `refreshAK()` (re-fetch this device's envelope → unwrap the new AK) when needed, then staging the DEK, and posts back `key-staged` / `ak-refreshed`. Decode stalls that one bucket, then retries.

Writes under a stale-but-retained primary `key_id` are harmless (old DEK still decrypts); the write-primary refresh after a *remote* DEK rotation is the soft edge and is refreshed on the next metadata poll.

## User Flows

| Scenario              | What happens                                                                                                                                                     |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **First device**      | Generate device key pair + random seed → derive AK (KDF) → mint DEK (`key_id=0`), wrap with AK → wrap AK into device envelope → create canary + signing keypair → upload keyring/envelope/canary/`signing_public_key`/`kdf_salt` atomically → show the 24-word recovery key once. |
| **Additional device** | New device generates its keys → waits for approval → a trusted device wraps the AK for it (gated by an `approve` challenge proof) → new device unwraps the AK, fetches + unwraps the DEK keyring, starts syncing. |
| **Returning device**  | Device key pair present locally, AK/DEK missing → fetch own envelope → unwrap AK → fetch + unwrap DEK keyring → sync resumes.                                     |
| **Recovery key**      | User enters 24-word phrase → seed → fetch `kdf_salt` → derive AK (KDF) → verify via canary + signing challenge → fetch + unwrap DEK keyring → create a new device envelope → resume. |
| **Recovery-key change** | Implemented as an AK rotation: new seed → new AK → re-wrap keyring → new envelopes → new 24-word key. Zero data re-encryption.                                  |
| **Sign out**          | All local keys cleared (`clearAllKeys` enumerates AK + every `thunderbolt_dek_*`) → next sign-in is treated as a new device.                                       |
| **Revoke device**     | Envelope deleted server-side + `revoked_at` set + sessions revoked (challenge-gated), then AK **and** DEK rotated → the device is locked out of the keyring and future data. |
| **v1 → v2 (beta reset)** | A v1 account (metadata exists, `signing_public_key` is NULL) calls `POST /v1/encryption/reset` to wipe v1 state, then runs fresh v2 setup. v1 ciphertext (written with no AAD under a discarded CK) is intentionally left undecryptable — no migration framework. |

## Backend Schema

All E2EE tables are **server-only** (not synced through PowerSync).

| Table                 | Notes                                                                                                                                                                                 |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `wrapped_keys`        | DEK keyring. PK `(key_id, user_id)`; `wrapped_key` = AES-KW(DEK) under AK (base64). One row per `key_id`; old versions retained. FK `user_id` → `user.id` `onDelete: cascade`.        |
| `challenge_nonces`    | Single-use challenge nonces. PK `nonce`; `user_id`, `operation`, `device_id`, `expires_at`, `consumed`. Swept periodically. FK cascade.                                              |
| `encryption_metadata` | Dropped `canary_secret_hash`; added `signing_public_key`, `kdf_salt`, `key_version` (int, default 1), `primary_key_id` (text, default `'0'`); kept `canary_iv` / `canary_ctext`.     |
| `envelopes`           | No schema change — `wrappedCk` now carries the AK.                                                                                                                                    |

### Endpoints

| Endpoint                              | Purpose                                                                                                    |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `POST /v1/devices/:id/envelope`       | Store a device envelope. Three paths: first-device bootstrap (atomic v2 setup), self-recovery/re-key, and approval — the last two require a challenge proof. |
| `GET /v1/devices/me/envelope`         | Fetch this device's envelope (the wrapped AK).                                                        |
| `GET /v1/encryption/canary`           | Encryption metadata — canary + `kdf_salt` + `signing_public_key` + `key_version` + `primary_key_id`. The rotation-detection poll. |
| `GET /v1/encryption/keys`             | The full wrapped-DEK keyring (for staging). Any authenticated **non-revoked** device — a wrapped DEK is inert without the AK, and a recovering device needs it before it is trusted. |
| `GET /v1/encryption/keys/:keyId`      | One wrapped DEK by `key_id`.                                                                               |
| `POST /v1/encryption/keys`            | Mint a new `key_id` (DEK rotation / workspace DEK). Idempotent per `key_id`; can never overwrite an existing wrapping. Trusted devices only. |
| `GET /v1/encryption/challenge`        | Issue a single-use nonce for a given operation.                                                           |
| `POST /v1/encryption/rotate`          | Atomic AK rotation: replace all envelopes + re-wrap the **whole** keyring + replace canary/signing key/`kdf_salt` + bump `key_version`. Challenge-gated, advisory-locked. |
| `POST /v1/encryption/reset`           | v1 → v2 beta reset. Allowed only for v1 accounts (`signing_public_key` IS NULL).                          |
| `POST /v1/devices/:id/deny`           | Deny a pending device (challenge-gated).                                                                  |

## Local Key Storage (IndexedDB)

| Key                                | Type                                              | Purpose                                                                 |
| ---------------------------------- | ------------------------------------------------- | ----------------------------------------------------------------------- |
| `thunderbolt_private_key`          | CryptoKey (non-extractable)                       | ECDH private key                                                        |
| `thunderbolt_public_key`           | CryptoKey                                         | ECDH public key                                                         |
| `thunderbolt_mlkem_public_key`     | Uint8Array                                        | ML-KEM public key                                                       |
| `thunderbolt_mlkem_secret_key`     | encrypted blob (`{iv, ciphertext}`)               | ML-KEM secret, **encrypted at rest** via self-ECDH → HKDF(`"mlkem-at-rest-v1"`) → AES-GCM (not raw bytes) |
| `thunderbolt_ak`                   | CryptoKey (non-extractable, `wrapKey`/`unwrapKey`) | Account Key                                                             |
| `thunderbolt_dek_{keyId}`          | CryptoKey (non-extractable, `encrypt`/`decrypt`)   | Data Encryption Key per `key_id` (`thunderbolt_dek_0`, …)               |
| `thunderbolt_primary_key_id`       | string                                            | The current primary `key_id` pointer                                    |
| `thunderbolt_key_version`          | number                                            | Last applied `key_version` (rotation-detection baseline)                |

`clearAllKeys` enumerates the store rather than deleting a fixed list, so every dynamically-named `thunderbolt_dek_*` is wiped on sign-out/reset. Self-ECDH is used for the ML-KEM-at-rest key (not the AK) to avoid a circular dependency — unwrapping the AK envelope itself needs the ML-KEM secret.

## Adding a New Encrypted Column

Add the table and column to `encryptedColumnsMap` in [src/db/encryption/config.ts](../../src/db/encryption/config.ts). The map is the **encode-selection** authority (which columns get encrypted on upload); the download path stays prefix-gated, so a stale bundle still decrypts a newly-encrypted column. The upload encoder threads the `{table, column, rowId}` context into the codec so AAD is bound automatically.

## Key Files

| File                                                | Role                                                                         |
| --------------------------------------------------- | ---------------------------------------------------------------------------- |
| `shared/e2ee-types.ts`                              | Cross-boundary contracts: wire format, `encodeAAD`, `encodeChallengePayload`, ECDSA/KDF constants, API DTOs |
| `src/crypto/primitives.ts`                          | AK/DEK generation, hybrid envelope wrap/unwrap, ML-KEM-at-rest, AES-256-GCM  |
| `src/crypto/key-storage.ts`                         | IndexedDB-backed key storage (AK, DEK keyring, primary pointer, key_version) |
| `src/crypto/canary.ts`                              | Canary creation/verification + deterministic ECDSA signing keypair           |
| `src/crypto/recovery-key.ts`                        | BIP-39 seed encode/decode + KDF derivation of the AK                         |
| `src/db/encryption/config.ts`                       | Encrypted-columns map + encryption-enabled/setup gates                       |
| `src/db/encryption/codec.ts`                        | v2 AES-GCM codec, `key_id`-indexed keyring cache, lazy-fetch/self-heal        |
| `src/db/encryption/wire-format.ts`                  | `__enc:v2:` parse/format                                                     |
| `src/db/encryption/key-request-responder.ts`        | Main-thread responder: key_version polling, keyring staging, AK refresh      |
| `src/services/encryption.ts`                        | Service layer orchestrating setup / approve / recover / rotate / revoke      |
| `backend/src/api/encryption.ts`                     | Backend encryption API routes                                                |
| `backend/src/lib/canary.ts`                         | Backend challenge-proof verification                                         |
| `backend/src/dal/encryption.ts`                     | Backend data access (keyring, nonces, metadata)                              |

## Sync Pipeline Integration

Encryption is implemented as a PowerSync transform-middleware. On **Chrome/Edge/Firefox** it runs inside a custom SharedWorker so key material stays in one place across tabs; on **Safari and Tauri** it runs on the main thread because those environments don't support SharedWorker. Because the SharedWorker has no auth token, key fetching/staging and AK refresh happen on the main thread and are relayed to the worker over the `thunderbolt-keys-sync` `BroadcastChannel` (see [Rotation Propagation](#rotation-propagation-polling--lazy-fetch)). See [Multi-Device Sync](./multi-device-sync.md#two-sync-paths) and [powersync-sync-middleware.md](./powersync-sync-middleware.md) for the full architecture.
