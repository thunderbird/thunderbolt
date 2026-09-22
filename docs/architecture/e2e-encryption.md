# End-to-End Encryption

> ⚠️ End-to-end encryption is in **Preview**. It has not yet undergone a cryptography audit and is subject to further refinements.

Thunderbolt supports optional zero-knowledge end-to-end encryption. Coverage is per column and opt-in: the columns listed in `encryptedColumnsMap` are encrypted client-side before sync and decrypted client-side after download, and for those columns the server stores only ciphertext and wrapped keys — it cannot read them even if compelled or breached. Everything else syncs in plaintext. See [What Is and Isn't Encrypted](#what-is-and-isnt-encrypted) for the current set.

For the sync pipeline integration, see [powersync-sync-middleware.md](powersync-sync-middleware.md).

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

**Frontend control point:** `isEncryptionEnabled()` in `src/db/encryption/config.ts` reads the cached flag from `localStorage`. The companion `needsSyncSetupWizard()` helper combines the encryption-enabled check with the CK-exists check — it returns `true` only when E2EE is on and no Content Key has been set up yet. Both the sign-in flow and the sync toggle use this helper to decide whether to show the setup wizard or enable sync directly.

**Backend control point:** `e2eeEnabled` in `backend/src/config/settings.ts`. When `false`, `validateDeviceForSync()` skips the trust check and `issuePowerSyncToken()` auto-trusts devices on upsert.

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

There's one content key per account. Each device has its own keypair. The CK is wrapped separately for every device using a hybrid envelope. Each device unwraps its own envelope to arrive at the same CK.

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

Encrypted column values on the wire are written as:

```
__enc:<iv-base64>:<ciphertext-base64>
```

Upload encryption reads `encryptedColumnsMap` in [src/db/encryption/config.ts](../../src/db/encryption/config.ts) to decide what to encrypt. Download decryption does not: `EncryptionMiddleware` decrypts any string value carrying the `__enc:` prefix, whatever its column. The prefix is the authoritative signal precisely so that a stale desktop bundle — whose compiled-in map predates a newly encrypted column — still decrypts correctly instead of writing ciphertext into SQLite.

## What Is and Isn't Encrypted

[`encryptedColumnsMap`](../../src/db/encryption/config.ts) is the single source of truth. `encodeForUpload` (`src/db/encryption/upload-encoder.ts`) looks the operation's table up in the map and returns the row unchanged when there is no entry, so **a synced table absent from the map uploads in plaintext** — the silent default when someone adds a table.

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
| `agents`         | _(none — the whole table syncs in plaintext)_             |

Two gaps are deliberate and one is not.

- **Structural columns stay plaintext across every table.** Ids, foreign keys, `deleted_at`, ordering, and boolean flags are what sync rules filter on and what local queries index; encrypting them would break both.
- **`projects.icon` and `projects.pinned_order` stay plaintext** because neither carries user-authored content — the icon is a single emoji picked from a fixed set.
- **`agents` has no entry at all**, so a user-created ACP agent's `name`, `url`, `description` and `icon` reach the server in the clear even with E2EE on. That is an omission rather than a decision; the table is synced (`shared/powersync-tables.ts`) and its columns are user-authored (`src/db/tables.ts`, `backend/src/db/powersync-schema.ts`).

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

A device row (`devices` in `backend/src/db/powersync-schema.ts`) encodes its state in three columns — `trusted`, `approval_pending`, `revoked_at` — rather than a single status enum, so every state is a combination:

| State                    | `trusted` | `approval_pending` | `revoked_at` |
| ------------------------ | --------- | ------------------ | ------------ |
| Pending approval         | false     | true               | null         |
| Trusted                  | true      | false              | null         |
| Denied or self-cancelled | false     | false              | null         |
| Revoked                  | false     | false              | set          |

`registerDevice` inserts pending, and on conflict resets an existing non-revoked row back to pending with fresh public keys — a re-registered device must go through approval again. From there:

- **Pending → trusted** via `markDeviceTrusted`, which the envelope route calls after storing the wrapped CK. Its `WHERE` requires `approval_pending = true`, so if a deny committed first the update matches zero rows and the caller gets a 403 instead of silently trusting a denied device.
- **Pending → denied** via `denyDevice`, from either a trusted device (`POST /devices/:deviceId/deny`) or the pending device itself (`POST /devices/me/cancel-pending`). Denial also clears `node_id`/`node_id_attested_at`, and `setDeviceNodeId` excludes denied and revoked rows — a denied peer cannot re-bind a P2P identity.
- **Any → revoked** via `POST /v1/account/devices/:id/revoke` in `backend/src/api/account.ts` (see [powersync-account-devices.md](powersync-account-devices.md)), which in one transaction deletes the envelope, calls `revokeDevice` to stamp `revoked_at` and clear both trust flags and the P2P binding, then revokes the device's sessions. When encryption metadata exists the route also demands a canary secret and a trusted `normal` caller, so a device with no CK cannot revoke one that has it.

### Device cap

`maxActiveDevicesPerUser = 10` in `backend/src/dal/devices.ts`. `countActiveDevices` counts only trusted, non-revoked rows — pending devices are deliberately excluded (THU-502) so a device waiting for approval can't lock a user out of registering. That exclusion is why the cap is enforced **twice**: once at registration and again at approval, in the envelope route. Without the second check a user could register eleven pending devices and approve them all.

`POST /devices` answers **422** `{ "error": "Device limit reached" }`. The CLI registration path (`backend/src/api/account.ts`) has its own **422** with the machine-readable `{ "code": "DEVICE_LIMIT_REACHED" }`.

### Device types

`device_type` is `'normal' | 'bridge' | 'cli'` and is **server-set only** — it is in the `uploadDenyColumns` list for `devices` in `backend/src/dal/powersync.ts`, alongside `trusted`, `approval_pending`, `revoked_at`, the public keys and `node_id`. A client therefore cannot relabel its own device a bridge through a raw PowerSync upload. `bridge` and `cli` are each written by exactly one route; `normal` is the column default, so any route that upserts a device without naming a type produces one.

| Type     | Created by                                                     | Notes                                                                                                                                                                |
| -------- | -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `normal` | `POST /devices`, or `issuePowerSyncToken` on first token issue | An app install. On the E2EE path it holds a device key pair and an envelope; with E2EE off the token route upserts it trusted and neither exists.                    |
| `bridge` | `POST /devices/bridge`                                         | A headless ACP/MCP bridge, keyed on a hash of (`userId`, `nodeId`) so re-registration is idempotent. Inserted trusted — the user added it deliberately. Holds no CK. |
| `cli`    | `PUT /v1/account/devices/cli`                                  | Account-only. Excluded from every encryption route and from the node-id and allowlist queries.                                                                       |

## API Endpoints

All routes below are served by `backend/src/api/encryption.ts` under the global `/v1` prefix (`backend/src/index.ts`) and all require an authenticated session.

Six of them additionally read the caller's own device id from the **`X-Device-ID`** request header and answer **400** when it is absent. That header is client-set and therefore never an authorization on its own: what actually gates the trust-sensitive routes is a _canary secret_ — proof that the caller can decrypt the account canary, and so holds the Content Key. A pending device cannot produce one. The one exception, `POST /devices/me/node-id`, takes no canary and instead pins the caller to the server-side `session.deviceId`.

| Method   | Path                          | `X-Device-ID` | Purpose                                                                                                         |
| -------- | ----------------------------- | ------------- | --------------------------------------------------------------------------------------------------------------- |
| `POST`   | `/devices`                    | —             | Register or re-identify this device with its ECDH and ML-KEM public keys. Binds the session to the device.      |
| `POST`   | `/devices/:deviceId/envelope` | required      | Store a wrapped CK for a device, promoting it from pending to trusted.                                          |
| `GET`    | `/devices/me/envelope`        | required      | Fetch this device's own wrapped CK.                                                                             |
| `GET`    | `/encryption/canary`          | —             | Fetch `canaryIv`/`canaryCtext` for recovery-key verification. Its 404 doubles as the "is E2EE set up?" probe.   |
| `POST`   | `/devices/:deviceId/deny`     | required      | A trusted device rejects a pending device.                                                                      |
| `POST`   | `/devices/me/cancel-pending`  | required      | A pending device withdraws its own request.                                                                     |
| `POST`   | `/devices/:deviceId/node-id`  | required      | A trusted device attests another device's iroh endpoint identity.                                               |
| `POST`   | `/devices/me/node-id`         | required      | A device self-enrolls its own iroh endpoint identity.                                                           |
| `GET`    | `/devices/allowlist`          | —             | The account's trusted, non-revoked `node_id`s. A bridge fetches and caches it to auto-allow same-account peers. |
| `POST`   | `/devices/bridge`             | —             | Register a bridge device for the account.                                                                       |
| `DELETE` | `/devices/:deviceId`          | —             | Hard-delete a device row. Only a bridge that is already revoked qualifies.                                      |

### `POST /devices/:deviceId/envelope`

The route that actually grants trust, and the one with the most conditions. It accepts exactly three shapes:

1. **First-device bootstrap** — no envelopes exist for the account and the caller is storing for itself. `canaryIv`, `canaryCtext` and `canarySecret` are all required, because without a canary there is no recovery path later. If encryption metadata already exists the supplied secret must verify against it, which stops a re-bootstrap from resetting the account's E2EE state even if the revocation checks were bypassed.
2. **Self-recovery** — caller and target are the same device and the canary secret verifies. This is the path a device takes after the user enters a recovery key.
3. **Approval** — a trusted, non-CLI caller stores an envelope for someone else's pending row, with a valid canary secret.

Storing for an already-trusted device from a _different_ caller is **409**; only a device may re-key its own envelope. Once the envelope is written, the trusted transition runs only for a target that wasn't already trusted — re-keying a trusted device changes nothing else, and running `markDeviceTrusted` on it would match zero rows and be misread as a revoke.

Notable failure codes: **400** missing header or incomplete bootstrap canary; **403** revoked device, missing or invalid canary secret, untrusted caller, or a concurrent revoke or deny; **404** unknown device, another user's device, or a CLI device; **409** envelope overwrite of a trusted device.

## Adding a New Encrypted Column

To encrypt a new column, add the table and column name to `encryptedColumnsMap` in [src/db/encryption/config.ts](../../src/db/encryption/config.ts). That is the only change needed: `encodeForUpload` encrypts every column in the map on upload, and `encryptionMiddleware` decrypts by `__enc:` prefix on download, so neither needs to know about the new column ahead of time. Rows already synced in plaintext are not retro-encrypted — only writes made after the change are.

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

Encryption is implemented as a PowerSync transform-middleware. On **Chrome/Edge/Firefox** it runs inside a custom SharedWorker so the CK stays in one place across tabs; on **Safari and Tauri** it runs in a dedicated Worker, which stands in for the SharedWorker those environments can't use (`sync: { worker: () => createDedicatedSyncWorker(dbFilename) }` in `src/db/powersync/database.ts`). Either way download decryption happens off the UI thread. Upload encryption does not: `encodeForUpload` runs in `ThunderboltConnector.uploadData` on the main thread, so the CK cache exists there too — which is why `invalidateCKCache()` broadcasts over a `BroadcastChannel` rather than clearing one copy. See [Multi-Device Sync](./multi-device-sync.md#two-sync-paths) and [powersync-sync-middleware.md](./powersync-sync-middleware.md) for the full architecture.
