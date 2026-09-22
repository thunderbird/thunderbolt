# PowerSync, Account & Device Management

This is the reference for the sync schema and the account/device routes:

- **PowerSync**: synced tables, local dev, adding, removing and extending tables
- **Devices**: the `devices` table, device identity, and CLI/bridge rows
- **Backend API**: token issuance, upload, account deletion, revoke and the encryption routes

The user-facing side of those routes — what the account's other devices do when one is revoked or the account is deleted — is in [delete-account-and-revoke-device.md](delete-account-and-revoke-device.md). The sync pipeline itself (two worker paths, local-only tables, offline behavior) is in [multi-device-sync.md](multi-device-sync.md).

---

## 1. PowerSync Overview

PowerSync provides offline-first sync between the backend (PostgreSQL) and clients (SQLite). Data is scoped by `user_id` from the JWT. The backend issues PowerSync JWTs and can apply client uploads (PUT/PATCH/DELETE) to Postgres. Production runs the self-hosted PowerSync service on Render (image: `ghcr.io/thunderbird/thunderbolt/thunderbolt-powersync`); local development uses the Docker stack in `powersync-service/`. The frontend never hard-codes the PowerSync URL — the backend returns it in `/powersync/token`, so URL changes are transparent to clients.

For the sync data transformation middleware and custom SharedWorker (E2E encryption pipeline), see [powersync-sync-middleware.md](powersync-sync-middleware.md).

---

## 2. Synced Tables

### Requirements

- Every synced table must have a **`user_id`** column (sync rules and backend scope by `user_id`).
- Define the table in **both**:
  - Frontend: [src/db/tables.ts](../../src/db/tables.ts) (SQLite)
  - Backend: [backend/src/db/powersync-schema.ts](../../backend/src/db/powersync-schema.ts) (PostgreSQL)
- **Backend schema uses minimal indexes**: Only primary keys and `user_id` indexes (see [Indexes and Foreign Keys](#indexes-and-foreign-keys) below).

### Current Tables

Defined in [shared/powersync-tables.ts](../../shared/powersync-tables.ts):

`settings`, `chat_threads`, `chat_messages`, `tasks`, `models`, `prompts`, `skills`, `triggers`, `model_profiles`, `devices`, `agents`, `projects`.

### Indexes and Foreign Keys

The backend schema carries primary keys and a single `user_id` index per table, and nothing else — no composite foreign key constraints, no active (`WHERE deletedAt IS NULL`) indexes, no foreign-key indexes. The frontend SQLite schema is free to add whatever local queries need, because that is where queries actually run.

The rationale lives with the schema design it follows from: [Index Strategy: user_id Only](composite-primary-keys-and-default-data.md#index-strategy-user_id-only).

### Adding a New Synced Table

1. Create the table in both `src/db/tables.ts` and `backend/src/db/powersync-schema.ts` (include `user_id`).
2. **Backend schema**: Add only a `user_id` index: `index('idx_[table]_user_id').on(table.userId)`. Do not add composite foreign keys or other indexes (see above).
3. Register in [src/db/powersync/schema.ts](../../src/db/powersync/schema.ts) (`drizzleSchema`).
4. Add the table name and query keys in [shared/powersync-tables.ts](../../shared/powersync-tables.ts) (`powersyncTableNames` and `powersyncTableToQueryKeys`). The query-key entry is required by the map's type but has no runtime consumer — reactivity comes from PowerSync itself; see the note on the map.
5. Update **all three** sync-rule configs so local, preview, prod, and enterprise-k8s stay in parity:
   - [powersync-service/config/config.yaml](../../powersync-service/config/config.yaml) — local docker-compose.
   - [deploy/config/powersync-config.yaml](../../deploy/config/powersync-config.yaml) — baked into the `ghcr.io/thunderbird/thunderbolt/thunderbolt-powersync` image; used by preview stacks (Pulumi) and prod on Render.
   - [deploy/k8s/templates/configmaps.yaml](../../deploy/k8s/templates/configmaps.yaml) — Helm-rendered config for the enterprise k8s deploy path.
     Add a line under `sync_rules.content` → the appropriate bucket in each: `bucket_definitions.user_essentials.data` for latency-sensitive tables (loaded first, priority 1), or `bucket_definitions.user_data.data` for the rest (priority 2). Example: `- SELECT * FROM powersync.my_table WHERE user_id = bucket.user_id`.
6. Generate the backend migration with `bun db generate` and check that `backend/drizzle/meta/_journal.json` gained the new entry — Drizzle finds pending migrations through the journal, so an SQL file without a journal entry never runs.

### PR Flow for Adding Tables

Split the work into two PRs to avoid sync rule mismatches:

1. **PR 1 – Backend schemas, migrations, and sync rules**
   - Backend: table in `backend/src/db/powersync-schema.ts`, migration (journal entry included — step 6 above), `shared/powersync-tables.ts`, and all three sync-rule configs (see step 5 above).
   - Merge this PR first, then run the migration. On merge, `.github/workflows/images-publish.yml` rebuilds `ghcr.io/thunderbird/thunderbolt/thunderbolt-powersync` with the updated sync rules baked in.
   - **Roll the Render `powersync` service to the new image tag** (dashboard → Manual Deploy → Deploy latest reference) before merging PR 2. Preview stacks pick up the new image on their next Pulumi apply.

2. **PR 2 – Frontend and remaining changes**
   - Frontend: table in `src/db/tables.ts`, `src/db/powersync/schema.ts`, plus DAL, defaults, reconciliation and UI.
   - Merge after PR 1's image is live on Render. Shipping the frontend first causes silent sync failure — the table works locally but never replicates.

### Adding Columns to an Existing Synced Table

Every current sync rule is a `SELECT *`, so a new column needs no rule edit — but it only replicates once the backend migration has run against the database the `powersync` service replicates from. If the frontend schema ships first, the column stays null across devices while local tests pass. When backend and frontend land in the same PR (e.g. `devices.node_id` / `node_id_attested_at`), splitting is unnecessary if the feature tolerates a null value, but the deployer must still run the migration before relying on the column cross-device.

### Removing a Synced Table

The add flow in reverse, with one rule that is easy to miss: **move the name from `powersyncTableNames` to `legacyPowerSyncTableNames` in [shared/powersync-tables.ts](../../shared/powersync-tables.ts) rather than deleting it, and never re-add it.** `backend/src/dal/powersync.ts` builds a `legacyTables` set from that list and makes `applyOperation` accept-and-ignore its upload ops. Without the entry the table is simply unknown, `PUT /powersync/upload` answers **400** `UPLOAD_OPERATION_FAILED`, and PowerSync retries the batch forever — so any device that queued a write before the table was dropped wedges its CRUD queue permanently and stops uploading anything else.

Then drop the table's line from all three sync-rule configs (step 5 above), remove it from `src/db/tables.ts` and `src/db/powersync/schema.ts`, and decide separately whether to drop the Postgres table (a retention question, not a sync one).

Two names are on the legacy list today: `modes` (THU-739) and `project_files`, which never reached production but was live long enough on preview stacks and local branches to leave queued writes behind.

---

## 3. Local Development (PowerSync Docker)

See [powersync-service/README.md](../../powersync-service/README.md) for full steps. Summary:

- From the repo root: `make up` (or from `powersync-service/`: `docker compose up -d`)
- PowerSync API: http://localhost:8080
- Postgres: localhost:5433 (use this for the backend so PowerSync and app share one database)
- Backend `.env`: set `DATABASE_DRIVER=postgres`, `DATABASE_URL=postgresql://postgres:postgres@localhost:5433/postgres`, and PowerSync vars (see below)
- Sync rules in `powersync-service/config/config.yaml` must match backend tables; when you add/change tables, update that file. The backend's upload validator (`validTables` in `backend/src/dal/powersync.ts`) is derived from `powersyncTableNames` in `shared/powersync-tables.ts` automatically — no manual sync needed there.

### Backend PowerSync Env Vars (Local)

```bash
POWERSYNC_URL=http://localhost:8080
POWERSYNC_JWT_SECRET=powersync-dev-secret-change-in-production
POWERSYNC_JWT_KID=powersync-dev
POWERSYNC_TOKEN_EXPIRY_SECONDS=3600
```

The local `config/config.yaml` uses HS256 with the same secret (base64) and kid so backend-issued tokens are accepted.

---

## 4. Account Deletion

`DELETE /v1/account` hard-deletes the `user` row ([backend/src/dal/users.ts](../../backend/src/dal/users.ts)); every synced table cascades on `user_id`. After that, any PowerSync token request that resolves to a session whose user is gone answers **410 Gone** with `code: 'ACCOUNT_DELETED'` — which is how the account's other devices find out.

Deletion is one of the sanctioned hard deletes (see the delete policy in [AGENTS.md](../../AGENTS.md)); the frontend only triggers it. For where the button is and what each device does afterwards, see [Delete Account](delete-account-and-revoke-device.md#delete-account).

---

## 5. Device Management

### Devices Table

Synced via PowerSync. Defined in [backend/src/db/powersync-schema.ts](../../backend/src/db/powersync-schema.ts) and mirrored in the client's local DB ([src/db/tables.ts](../../src/db/tables.ts)) with the booleans as SQLite integers and without `app_version` — that column is written server-side for operators and no client reads it back.

| Column                           | Meaning                                                                                     |
| -------------------------------- | ------------------------------------------------------------------------------------------- |
| `id`, `user_id`                  | device id and owner; the `bridge-` and `cli-` id namespaces are server-reserved             |
| `name`, `app_version`            | from `X-Device-Name` and `X-App-Version` on the token request, length-capped                |
| `last_seen`, `created_at`        | `last_seen` refreshed by `upsertDevice` on every token request; `created_at` only on insert |
| `trusted`, `approval_pending`    | drive the approve/deny queue in Settings > Devices                                          |
| `public_key`, `mlkem_public_key` | the device's public keys for envelope wrapping; see [e2e-encryption.md](e2e-encryption.md)  |
| `revoked_at`                     | soft revoke; set by the revoke route, never cleared                                         |
| `device_type`                    | `normal`, `bridge` or `cli` — one shared revocation lifecycle for all three                 |
| `node_id`, `node_id_attested_at` | iroh P2P identity, written only by dedicated routes (section 6), never by a sync upload     |

**There is no `status` column.** Device state is three independent fields, so every check has to spell out the combination it means:

| State            | Condition                                                             |
| ---------------- | --------------------------------------------------------------------- |
| Pending approval | `trusted = false AND approval_pending = true AND revoked_at IS NULL`  |
| Trusted          | `trusted = true AND revoked_at IS NULL`                               |
| Denied           | `trusted = false AND approval_pending = false AND revoked_at IS NULL` |
| Revoked          | `revoked_at IS NOT NULL`                                              |

- `device_type` puts the iroh bridge and the account-only CLI installation on the same row shape and the same revocation lifecycle, so the DAL guards carry the distinction instead: `markDeviceTrusted`, `denyDevice`, and `setDeviceNodeId` all exclude `cli` rows, and `getPendingDevices` ([src/dal/devices.ts](../../src/dal/devices.ts)) only offers `normal` ones for approval (a null `device_type`, from a row that synced before the column shipped, counts as normal).
- Every trust-sensitive column is server-managed. `revoked_at`, `trusted`, `approval_pending`, `public_key`, `mlkem_public_key`, `app_version`, `device_type`, `node_id` and `node_id_attested_at` are in `uploadDenyColumns` and are stripped from any PowerSync `PUT`/`PATCH`, and `devices` is in `uploadDenyDelete`, so a sync `DELETE` for the table is rejected outright — a row can only be removed through the API route in section 6 ([backend/src/dal/powersync.ts](../../backend/src/dal/powersync.ts), and [powersync-upload-authorization.md](powersync-upload-authorization.md) for the whole gate).
- `node_id` / `node_id_attested_at` hold the iroh P2P endpoint identity. Three routes write them — the canary-gated `POST /devices/:deviceId/node-id`, the session-pinned `POST /devices/me/node-id`, and bridge registration (`registerBridgeDevice`) — and both revoke and deny clear them so a removed device stops being dialable.
- See [e2e-encryption.md](e2e-encryption.md) for how `trusted`, `approval_pending`, and `public_key` are used in the encryption setup and device approval flows.

### Settings > Devices

The device list, the pending-approval queue, the revoke and remove buttons, and the pairing-identity dialog are described in [Settings > Devices Page](delete-account-and-revoke-device.md#settings--devices-page), together with the user-facing [revoke flow](delete-account-and-revoke-device.md#revoke-device). This document covers the routes those controls call (section 6).

### CLI Devices

The CLI uses account-first onboarding and a stable `cli-<uuid>` installation.
See [CLI Device Registration and Logout](#cli-device-registration-and-logout)
for the registration, binding, logout, and revocation contract.

CLI devices are account/revocation records, not PowerSync clients. The backend
rejects `cli-` IDs from PowerSync token and upload flows. The `cli-` namespace
is server-reserved, so a `device_type = 'cli'` row cannot reach these flows under
another ID. CLI provider profiles, model selection, account tokens, and confidential
cache material stay in the CLI's local state root and do not sync to the web app
or another CLI installation.

A trusted web device can revoke a CLI device through the regular device list.
The revoked CLI cannot continue using the bound session and must complete web
login again. Personal access tokens are separate: `THUNDERBOLT_TOKEN` supports
headless direct managed inference only, is not device-bound, and must be revoked
through the PAT lifecycle rather than CLI logout. Confidential models require a web
session unless the operator sets `CONFIDENTIAL_API_KEYS_ENABLED=true`; otherwise a
PAT request fails with `WEB_LOGIN_REQUIRED` without fallback or replay. See
[backend/docs/pat-lifecycle.md](../../backend/docs/pat-lifecycle.md) for why that
gate is an authorization choice rather than a property of the confidential
transport.

### Auth Token and Device ID

Both live in `localStorage` under fixed keys ([src/lib/auth-token.ts](../../src/lib/auth-token.ts)).

- **Auth token:** a fixed key so `getAuthToken()` can stay synchronous, as Better Auth requires. Not synced. Cleared by `clearAuthToken()` — on its own for a session expiry, or as part of `clearLocalData()` for a full reset. Nothing calls `localStorage.clear()`.
- **Device id:** created on first read. Sent as `X-Device-ID`, alongside `X-Device-Name`, on PowerSync requests so the backend can register or update the row and enforce revocation; the backend falls back to `Unknown device` when the name is absent.

---

## 6. Backend API

### PowerSync Token (`GET /powersync/token`)

- **Session path:** the device is validated by `validateDeviceForSync`, then the route issues a PowerSync JWT and upserts the device (id, user_id, name, last_seen, and `app_version` from `X-App-Version`).
- **Bearer token only (e.g. credential refresh):** the signed bearer token is verified and resolved to a persisted session. If the user row no longer exists (account deleted) → **410 Gone** with `{ code: 'ACCOUNT_DELETED' }`. Otherwise the same device validation and issuance run.
- `X-Device-ID` is required on both paths, so a revoked device cannot buy itself a token by omitting the header.
- With `POWERSYNC_JWT_SECRET` unset, `createPowerSyncRoutes` returns an empty Elysia instance and neither route is mounted at all, so the request 404s. With the secret set but `POWERSYNC_URL` empty, `/token` answers **503** without issuing anything.

### PowerSync Upload (`PUT /powersync/upload`)

- Requires an authenticated, non-anonymous user and an `X-Device-ID` header, and runs the same `validateDeviceForSync` — except that the device must already exist. Only the token route may create one: it passes `allowNewDevice: true`, so `upsertDevice` inserts the row, and only while E2EE is off (with E2EE on, a device that has not been through the envelope flow is untrusted and rejected).
- A rejected operation returns **400** with `{ code: 'UPLOAD_OPERATION_FAILED' }`, deliberately, so the client does not call `transaction.complete()` and PowerSync retries the batch. Ops for a table in `legacyPowerSyncTableNames` are accepted and ignored instead — see [Removing a Synced Table](#removing-a-synced-table) for why.

Both routes reject a cross-origin request whose `Origin` is not in the allowed CORS set with **403** `ORIGIN_NOT_ALLOWED`; an absent `Origin` (non-browser clients) is allowed.

Summary for the client. Only the rows with a reason change app state — [src/db/powersync/connector.ts](../../src/db/powersync/connector.ts) maps status and code to a `CredentialsInvalidReason`; for everything else `fetchCredentials` returns `null`, so PowerSync simply retries on its own schedule. Section 7 covers what each reason does.

| Status | Code                       | Meaning                                                           | Client reason                           |
| ------ | -------------------------- | ----------------------------------------------------------------- | --------------------------------------- |
| 410    | `ACCOUNT_DELETED`          | the user row is gone                                              | `account_deleted` — full reset          |
| 403    | `DEVICE_DISCONNECTED`      | `revoked_at` is set on this device                                | `device_revoked` — revoked-device modal |
| 403    | `DEVICE_NOT_TRUSTED`       | a `cli-` prefixed id, or (E2EE on) an unknown or untrusted device | none — expected while approval pends    |
| 403    | `ANONYMOUS_SYNC_FORBIDDEN` | anonymous session                                                 | `sync_not_permitted` — sync disabled    |
| 403    | `ORIGIN_NOT_ALLOWED`       | `Origin` outside the CORS allowlist                               | none                                    |
| 409    | `DEVICE_ID_TAKEN`          | the id is registered to another user                              | `device_id_taken` — full reset          |
| 400    | `DEVICE_ID_REQUIRED`       | no `X-Device-ID` header                                           | `device_id_required` — full reset       |
| 401    | —                          | missing, unsigned, or expired bearer token                        | `session_expired` — sign-in modal       |
| 503    | —                          | `/token` only: the secret is set but `POWERSYNC_URL` is empty     | none                                    |

### Revoke Device (`POST /v1/account/devices/:id/revoke`)

- Requires an authenticated session and an `X-Device-ID` header naming the **calling** device — **400** without it.
- When the account has encryption metadata, revocation additionally requires proof that the caller holds the Content Key, so a stolen session cannot evict the legitimate devices:
  - `canarySecret` (body, `maxLength: 500`) must be present and verify against the stored hash — **403** otherwise. The check keys on the presence of the metadata row rather than on `canarySecretHash`, so a row with a null hash fails closed instead of skipping the gate.
  - The calling device must itself be trusted, non-revoked, and `device_type = 'normal'` — **403** otherwise. An account with no encryption metadata skips both checks.
- Runs in a transaction under the per-account advisory lock: `deleteEnvelope` → `revokeDevice` → `revokeDeviceSessions` (the last only if `revokeDevice` matched a row).
- **204** on success, and idempotent — an already-revoked device matches nothing and its sessions are left alone.

Deleting the envelope is what makes revocation durable: the wrapped Content Key is gone, so the CK cannot be recovered later even if the device's private key leaks. Nulling `node_id` also de-authorizes the device on the iroh P2P path — `GET /v1/devices/allowlist` returns only the trusted, non-revoked, non-CLI `node_id`s on the account, and a running bridge refreshes that list on its 45-second membership heartbeat and tears down open sessions whose peer has dropped off it ([cli/src/iroh/bridge.ts](../../cli/src/iroh/bridge.ts), [cli/src/iroh/account-allowlist.ts](../../cli/src/iroh/account-allowlist.ts)).

### Remove Device (`DELETE /v1/devices/:deviceId`)

Removal is a hard delete and is deliberately narrow: only a **revoked bridge** device can be removed (**409** otherwise, **404** for a device that isn't the caller's). It revokes the device's sessions, then deletes the row. It exists because bridge registration refuses to resurrect a revoked bridge row with the same NodeId — the tombstone has to be cleared explicitly before pairing again ([backend/src/api/encryption.ts](../../backend/src/api/encryption.ts)).

### CLI Device Registration and Logout

- `PUT /v1/account/devices/cli` requires a valid non-anonymous persisted web
  session plus canonical CLI device, device-name, and app-version headers. It
  registers or touches the installation and binds that session to the device.
- `POST /v1/account/devices/cli/logout` is remote-first: it revokes the bound CLI
  device and all of its sessions before returning **204**.
- Revoked devices return `DEVICE_DISCONNECTED`; invalid or expired sessions
  return **401**. Clients do not replay a failed inference request after login.

### Managed Catalog Privacy

`GET /v1/config` publishes managed models through `defaults.models`: versioned
`SharedModel` rows without `apiKey`, plus `defaultModelId`. Price tables, quota
internals, credentials, and other deployment secrets remain backend-only.

For the mandatory old-client-safe rollout order, see
[CLI Device Rollout](../self-hosting/configuration.md#cli-device-rollout).

### Encryption API Endpoints

These handle encryption setup, device approval, iroh pairing, and key recovery. They are mounted on the `/v1` app without a sub-prefix (unlike the account routes above), so the full paths are `/v1/devices/…` and `/v1/encryption/canary`. All of them require an authenticated session; several also require canary proof-of-CK-possession. Defined in `backend/src/api/encryption.ts`; see [e2e-encryption.md](e2e-encryption.md) for the key hierarchy they operate on.

| Route                              | Purpose                                                                                               |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `POST /devices`                    | Register a device with its public key (encryption setup)                                              |
| `POST /devices/:deviceId/envelope` | Store a wrapped content key, which also marks the target device trusted                               |
| `GET /devices/me/envelope`         | Fetch this device's own wrapped content key                                                           |
| `GET /encryption/canary`           | Fetch the canary used to verify a recovery key                                                        |
| `POST /devices/:deviceId/deny`     | Deny a pending device — requires `canarySecret`                                                       |
| `POST /devices/me/cancel-pending`  | Withdraw this device's own pending request — `X-Device-ID`, no canary                                 |
| `POST /devices/:deviceId/node-id`  | Attest another device's iroh `node_id` — requires `canarySecret`                                      |
| `POST /devices/me/node-id`         | Self-enroll this device's own `node_id` — no canary, since it can only bind its own row               |
| `GET /devices/allowlist`           | The trusted, non-revoked `node_id`s on the caller's account (the bridge's peer allowlist)             |
| `POST /devices/bridge`             | Register an ACP/MCP bridge; the only way to create a `device_type = 'bridge'` row                     |
| `DELETE /devices/:deviceId`        | Hard-delete a revoked bridge row — see [Remove Device](#remove-device-delete-v1devicesdeviceid) above |

---

## 7. Frontend: Credentials-Invalid and Reset

A rejected token request is not one outcome. `getCredentialsInvalidReason` ([src/db/powersync/connector.ts](../../src/db/powersync/connector.ts)) turns the status and `code` from the table above into one of six reasons, and `usePowerSyncCredentialsInvalidListener` ([src/hooks/use-powersync-credentials-invalid-listener.ts](../../src/hooks/use-powersync-credentials-invalid-listener.ts)) gives each a different consequence — only three of the six destroy local data, because a session expiry or a device revocation must not cost the user their offline database. A seventh path watches the current device's synced `devices` row, so a revocation lands without waiting for the next token refresh.

The per-reason consequences, that watcher's cold-start guard, what `clearLocalData` ([src/lib/cleanup.ts](../../src/lib/cleanup.ts)) tears down, and a side-by-side summary of the two flows are in [delete-account-and-revoke-device.md](delete-account-and-revoke-device.md#frontend).
