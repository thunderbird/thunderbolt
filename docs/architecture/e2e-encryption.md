# End-to-End Encryption

> ⚠️ End-to-end encryption is in **Preview**. It has not yet undergone a cryptography audit and is subject to further refinements.

Optional zero-knowledge encryption, per column and opt-in. Columns in `encryptedColumnsMap` are encrypted client-side before upload and decrypted client-side after download, so the server holds only ciphertext and wrapped keys for them. Everything else syncs in plaintext ([current set](#what-is-and-isnt-encrypted)).

Sync pipeline integration: [powersync-sync-middleware.md](powersync-sync-middleware.md).

---

## Configuration

E2EE is **disabled by default**; the backend is the single source of truth.

| Variable       | Where          | Default | Effect when enabled                                                                                                  |
| -------------- | -------------- | ------- | -------------------------------------------------------------------------------------------------------------------- |
| `E2EE_ENABLED` | Backend `.env` | `false` | Requires device trust flow before allowing sync; frontend encrypts/decrypts data, shows setup wizard, generates keys |

```env
# Backend (backend/.env)
E2EE_ENABLED=true
```

The frontend reads the flag from `GET /v1/config` at app initialization and caches it in `localStorage` for offline use. There is no frontend environment variable.

When disabled, the backend auto-trusts devices and skips the envelope flow: no setup wizard, no key generation, no recovery key. The encryption endpoints remain, uncalled.

| Side     | Control point                                            | Behaviour                                                                                                                                                           |
| -------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Frontend | `isEncryptionEnabled()` in `src/db/encryption/config.ts` | Reads the cached flag. `needsSyncSetupWizard()` is true only when E2EE is on and no CK exists; sign-in and the sync toggle use it to pick wizard vs. direct enable. |
| Backend  | `e2eeEnabled` in `backend/src/config/settings.ts`        | When `false`, `validateDeviceForSync()` skips the trust check and `issuePowerSyncToken()` auto-trusts devices on upsert.                                            |

---

## Key Concepts

| Concept              | Description                                                                                                                                   |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| **Device key pair**  | Each device generates an **ECDH P-256** key pair and an **ML-KEM-768** key pair when sync is enabled. Private keys never leave the device.    |
| **Content key (CK)** | A single **AES-256-GCM** key that encrypts all user data. Identical across all devices of the same user.                                      |
| **Device envelope**  | The CK wrapped using hybrid ECDH + ML-KEM for a specific device. Only that device's private keys can unwrap it.                               |
| **Recovery key**     | CK encoded as a **24-word BIP-39 mnemonic**. Shown once at first setup. The only way to recover data if all devices are lost.                 |
| **Canary**           | A fixed plaintext encrypted with CK, stored server-side. Used to verify a recovery key is correct and to detect whether encryption is set up. |

## Key Hierarchy

One CK per account, wrapped separately for each device's key pair.

```
                         ┌─────────────────────────┐
                         │            CK           │
                         │  (one key, all records) │
                         └───────────┬─────────────┘
                    wrapped separately for each device
          ┌──────────────────┬──────────────────┬─────┐
          ▼                  ▼                  ▼
 ┌────────────────┐ ┌────────────────┐ ┌────────────────┐
 │ envelope       │ │ envelope       │ │ envelope       │
 │ device 1       │ │ device 2       │ │ device 3       │
 └───────┬────────┘ └───────┬────────┘ └───────┬────────┘
  unwrap with       unwrap with        unwrap with
  private key 1     private key 2      private key 3
          │                  │                  │
          ▼                  ▼                  ▼
          CK                 CK                 CK
      (identical)       (identical)        (identical)
```

## Wire Format

```
__enc:<iv-base64>:<ciphertext-base64>
```

Uploads consult `encryptedColumnsMap` in [src/db/encryption/config.ts](../../src/db/encryption/config.ts); downloads do not. `EncryptionMiddleware` decrypts any string carrying the `__enc:` prefix, whatever its column, so a stale desktop bundle whose compiled-in map predates a newly encrypted column still decrypts instead of writing ciphertext into SQLite.

## What Is and Isn't Encrypted

[`encryptedColumnsMap`](../../src/db/encryption/config.ts) is the single source of truth. `encodeForUpload` (`src/db/encryption/upload-encoder.ts`) passes a row through unchanged when its table has no entry, so **a synced table absent from the map uploads in plaintext**.

| Table            | Encrypted columns                                         |
| ---------------- | --------------------------------------------------------- |
| `settings`       | `value`                                                   |
| `chat_threads`   | `title`                                                   |
| `chat_messages`  | `content`, `parts`, `cache`, `metadata`                   |
| `tasks`          | `item`                                                    |
| `models`         | `name`, `model`, `url`, `vendor`, `description`           |
| `prompts`        | `title`, `prompt`                                         |
| `triggers`       | `trigger_time`                                            |
| `model_profiles` | the twelve prompt-override and `provider_options` columns |
| `devices`        | `name`                                                    |
| `skills`         | `name`, `label`, `description`, `instruction`             |
| `projects`       | `name`, `description`, `instructions`                     |
| `agents`         | _(none; the whole table syncs in plaintext)_              |

- **Structural columns stay plaintext everywhere.** Ids, foreign keys, `deleted_at`, ordering and boolean flags are what sync rules filter on and what local queries index.
- **`projects.icon` and `projects.pinned_order` stay plaintext**: no user-authored content (the icon is one emoji from a fixed set).
- **`agents` has no entry**, so an ACP agent's `name`, `url`, `description` and `icon` reach the server in the clear even with E2EE on. An omission, not a decision: the table is synced (`shared/powersync-tables.ts`) and its columns are user-authored (`src/db/tables.ts`, `backend/src/db/powersync-schema.ts`).

## User Flows

| Scenario              | What happens                                                                                                                       |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| **First device**      | User enables sync → device generates key pair and CK → wraps CK for itself → recovery key is shown once.                           |
| **Additional device** | New device generates its own keys → waits for approval → a trusted device wraps CK for it → new device unwraps and starts syncing. |
| **Returning device**  | Key pair still present locally, CK missing → fetches own envelope → unwraps → sync resumes.                                        |
| **Recovery key**      | User enters 24-word phrase → CK decoded → canary verified → new envelope created for this device → sync resumes.                   |
| **Sign out**          | All local keys cleared → next sign-in is treated as a new device.                                                                  |
| **Revoke device**     | Envelope deleted server-side, `revoked_at` set → device can no longer decrypt or sync.                                             |

## Device Trust Lifecycle

`devices` (`backend/src/db/powersync-schema.ts`) encodes state in three columns rather than a status enum, so every state is a combination:

| State                    | `trusted` | `approval_pending` | `revoked_at` |
| ------------------------ | --------- | ------------------ | ------------ |
| Pending approval         | false     | true               | null         |
| Trusted                  | true      | false              | null         |
| Denied or self-cancelled | false     | false              | null         |
| Revoked                  | false     | false              | set          |

`registerDevice` inserts pending; on conflict it resets a non-revoked row back to pending with fresh public keys, so a re-registered device needs approval again.

| Transition            | How                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Pending → trusted** | `markDeviceTrusted`, called by the envelope route after storing the wrapped CK. Its `WHERE` requires `approval_pending = true`, so a deny that commits first makes the update match zero rows and the caller gets a 403.                                                                                                                                                                                                                                     |
| **Pending → denied**  | `denyDevice`, from a trusted device (`POST /devices/:deviceId/deny`) or the pending device itself (`POST /devices/me/cancel-pending`). Also clears `node_id`/`node_id_attested_at`; `setDeviceNodeId` excludes denied and revoked rows, so a denied peer cannot re-bind a P2P identity.                                                                                                                                                                      |
| **Any → revoked**     | `POST /v1/account/devices/:id/revoke` (`backend/src/api/account.ts`, see [powersync-account-devices.md](powersync-account-devices.md)): one transaction deletes the envelope, stamps `revoked_at` via `revokeDevice`, clears both trust flags and the P2P binding, then revokes the device's sessions. With encryption metadata present it also demands a canary secret and a trusted `normal` caller, so a device with no CK cannot revoke one that has it. |

### Device cap

`maxActiveDevicesPerUser = 10` in `backend/src/dal/devices.ts`. `countActiveDevices` counts only trusted, non-revoked rows; pending devices are excluded (THU-502) so a device awaiting approval can't lock a user out of registering. Hence the cap is enforced **twice**, at registration and again at approval in the envelope route: otherwise eleven pending devices could all be approved.

`POST /devices` answers **422** `{ "error": "Device limit reached" }`; the CLI registration path (`backend/src/api/account.ts`) has its own **422** with the machine-readable `{ "code": "DEVICE_LIMIT_REACHED" }`.

### Device types

`device_type` is `'normal' | 'bridge' | 'cli'` and is **server-set only**: it sits in `uploadDenyColumns` for `devices` (`backend/src/dal/powersync.ts`) alongside `trusted`, `approval_pending`, `revoked_at`, the public keys and `node_id`, so no client can relabel itself a bridge through a raw PowerSync upload. `normal` is the column default, so any route that upserts a device without naming a type produces one.

| Type     | Created by                                                     | Notes                                                                                                                                      |
| -------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `normal` | `POST /devices`, or `issuePowerSyncToken` on first token issue | An app install. On the E2EE path it holds a key pair and an envelope; with E2EE off the token route upserts it trusted and neither exists. |
| `bridge` | `POST /devices/bridge`                                         | A headless ACP/MCP bridge, keyed on a hash of (`userId`, `nodeId`) so re-registration is idempotent. Inserted trusted. Holds no CK.        |
| `cli`    | `PUT /v1/account/devices/cli`                                  | Account-only. Excluded from every encryption route and from the node-id and allowlist queries.                                             |

## API Endpoints

Served by `backend/src/api/encryption.ts` under the global `/v1` prefix (`backend/src/index.ts`); all require an authenticated session.

`X-Device-ID` carries the caller's own device id. It is client-set and never an authorization on its own: routes that need it answer **400** when it is absent, and trust-sensitive ones are gated by a _canary secret_, proof the caller can decrypt the account canary and so holds the CK. A pending device cannot produce one. `POST /devices/me/node-id` takes no canary and instead pins the caller to the server-side `session.deviceId`.

| Method   | Path                          | `X-Device-ID` | Purpose                                                                                                         |
| -------- | ----------------------------- | ------------- | --------------------------------------------------------------------------------------------------------------- |
| `POST`   | `/devices`                    | no            | Register or re-identify this device with its ECDH and ML-KEM public keys. Binds the session to the device.      |
| `POST`   | `/devices/:deviceId/envelope` | required      | Store a wrapped CK for a device, promoting it from pending to trusted.                                          |
| `GET`    | `/devices/me/envelope`        | required      | Fetch this device's own wrapped CK.                                                                             |
| `GET`    | `/encryption/canary`          | no            | Fetch `canaryIv`/`canaryCtext` for recovery-key verification. Its 404 doubles as the "is E2EE set up?" probe.   |
| `POST`   | `/devices/:deviceId/deny`     | required      | A trusted device rejects a pending device.                                                                      |
| `POST`   | `/devices/me/cancel-pending`  | required      | A pending device withdraws its own request.                                                                     |
| `POST`   | `/devices/:deviceId/node-id`  | required      | A trusted device attests another device's iroh endpoint identity.                                               |
| `POST`   | `/devices/me/node-id`         | required      | A device self-enrolls its own iroh endpoint identity.                                                           |
| `GET`    | `/devices/allowlist`          | no            | The account's trusted, non-revoked `node_id`s. A bridge fetches and caches it to auto-allow same-account peers. |
| `POST`   | `/devices/bridge`             | no            | Register a bridge device for the account.                                                                       |
| `DELETE` | `/devices/:deviceId`          | no            | Hard-delete a device row. Only a bridge that is already revoked qualifies.                                      |

### `POST /devices/:deviceId/envelope`

The route that grants trust. It accepts exactly three shapes:

| Shape                      | Accepted when                                                                                                                                                                                                                                                                                                                                                                                        |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **First-device bootstrap** | No envelopes exist for the account and the caller is storing for itself. `canaryIv`, `canaryCtext` and `canarySecret` are all required, since without a canary there is no recovery path later. If encryption metadata already exists the supplied secret must verify against it, which blocks a re-bootstrap that would reset the account's E2EE state even if the revocation checks were bypassed. |
| **Self-recovery**          | Caller and target are the same device and the canary secret verifies. This is the path after the user enters a recovery key.                                                                                                                                                                                                                                                                         |
| **Approval**               | A trusted, non-CLI caller stores an envelope for another device's pending row, with a valid canary secret.                                                                                                                                                                                                                                                                                           |

Storing for an already-trusted device from a _different_ caller is **409**; only a device may re-key its own envelope. The trusted transition runs only for a not-yet-trusted target, since `markDeviceTrusted` on a trusted row matches zero rows and would be misread as a revoke.

| Code    | Cause                                                                                              |
| ------- | -------------------------------------------------------------------------------------------------- |
| **400** | Missing header, or incomplete bootstrap canary                                                     |
| **403** | Revoked device, missing or invalid canary secret, untrusted caller, or a concurrent revoke or deny |
| **404** | Unknown device, another user's device, or a CLI device                                             |
| **409** | Envelope overwrite of a trusted device                                                             |

## Adding a New Encrypted Column

Add the table and column name to `encryptedColumnsMap` in [src/db/encryption/config.ts](../../src/db/encryption/config.ts). Nothing else: uploads encrypt every column in the map, downloads decrypt by `__enc:` prefix. Rows already synced in plaintext are not retro-encrypted.

## Key Files

| File                            | Role                                           |
| ------------------------------- | ---------------------------------------------- |
| `src/crypto/primitives.ts`      | Hybrid key wrapping + AES-256-GCM primitives   |
| `src/crypto/key-storage.ts`     | IndexedDB-backed key storage                   |
| `src/crypto/canary.ts`          | Canary creation and verification               |
| `src/crypto/recovery-key.ts`    | BIP-39 mnemonic encode/decode                  |
| `src/db/encryption/config.ts`   | Encrypted columns map (single source of truth) |
| `src/db/encryption/codec.ts`    | AES-GCM codec with CK cache                    |
| `src/services/encryption.ts`    | Service layer orchestrating all flows          |
| `backend/src/api/encryption.ts` | Backend encryption API routes                  |
| `backend/src/dal/encryption.ts` | Backend data access layer                      |

## Sync Pipeline Integration

Encryption is a PowerSync transform-middleware. On **Chrome/Edge/Firefox** it runs inside a custom SharedWorker so the CK stays in one place across tabs; **Safari and Tauri**, which cannot use one, get a dedicated Worker instead (`sync: { worker: () => createDedicatedSyncWorker(dbFilename) }` in `src/db/powersync/database.ts`). Download decryption is off the UI thread either way; upload encryption is not, because `encodeForUpload` runs in `ThunderboltConnector.uploadData` on the main thread. That second CK cache is why `invalidateCKCache()` broadcasts over a `BroadcastChannel`. See [Multi-Device Sync](./multi-device-sync.md#two-sync-paths) and [powersync-sync-middleware.md](./powersync-sync-middleware.md).
