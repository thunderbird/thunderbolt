# PowerSync, Account & Device Management

Reference for the sync schema, the `devices` table, and the account/device/encryption routes. See also [delete-account-and-revoke-device.md](delete-account-and-revoke-device.md) (what other devices do on revoke/delete), [multi-device-sync.md](multi-device-sync.md) (pipeline, local-only tables, offline) and [powersync-sync-middleware.md](powersync-sync-middleware.md) (transform middleware, SharedWorker).

---

## 1. PowerSync Overview

Offline-first sync between the backend (PostgreSQL) and clients (SQLite), scoped by `user_id` from the JWT. The backend issues the PowerSync JWTs and applies client uploads (PUT/PATCH/DELETE) to Postgres. Production is self-hosted on Render (`ghcr.io/thunderbird/thunderbolt/thunderbolt-powersync`); local is the Docker stack in `powersync-service/`.

The frontend never hard-codes the PowerSync URL; `/powersync/token` returns it, so URL changes stay transparent.

---

## 2. Synced Tables

Every synced table needs a **`user_id`** column: sync rules and the backend scope by it.

### Current Tables

[shared/powersync-tables.ts](../../shared/powersync-tables.ts): `settings`, `chat_threads`, `chat_messages`, `tasks`, `models`, `prompts`, `skills`, `triggers`, `model_profiles`, `devices`, `agents`, `projects`.

### Indexes and Foreign Keys

Backend: primary keys and one `user_id` index per table. No composite foreign keys, no active (`WHERE deletedAt IS NULL`) indexes, no foreign-key indexes. The frontend SQLite schema adds whatever local queries need, since that is where queries run. Rationale: [Index Strategy: user_id Only](composite-primary-keys-and-default-data.md#index-strategy-user_id-only).

### Adding a New Synced Table

1. Create the table in both [src/db/tables.ts](../../src/db/tables.ts) (SQLite) and [backend/src/db/powersync-schema.ts](../../backend/src/db/powersync-schema.ts) (PostgreSQL), with `user_id`.
2. Backend schema: add only `index('idx_[table]_user_id').on(table.userId)` ([why](#indexes-and-foreign-keys)).
3. Register in [src/db/powersync/schema.ts](../../src/db/powersync/schema.ts) (`drizzleSchema`).
4. Add the name and query keys to `powersyncTableNames` and `powersyncTableToQueryKeys` in [shared/powersync-tables.ts](../../shared/powersync-tables.ts). The query-key entry only satisfies the map's type; reactivity comes from PowerSync.
5. Update **all three** sync-rule configs so local, preview, prod, and enterprise-k8s stay in parity:

   | Config                                                                             | Used by                                                                 |
   | ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
   | [powersync-service/config/config.yaml](../../powersync-service/config/config.yaml) | local docker-compose                                                    |
   | [deploy/config/powersync-config.yaml](../../deploy/config/powersync-config.yaml)   | baked into the `thunderbolt-powersync` image: preview (Pulumi) and prod |
   | [deploy/k8s/templates/configmaps.yaml](../../deploy/k8s/templates/configmaps.yaml) | Helm-rendered config for enterprise k8s                                 |

   In each, add a line under `sync_rules.content` in `bucket_definitions.user_essentials.data` (latency-sensitive, priority 1) or `bucket_definitions.user_data.data` (the rest, priority 2), e.g. `- SELECT * FROM powersync.my_table WHERE user_id = bucket.user_id`.

6. Run `bun db generate` and confirm `backend/drizzle/meta/_journal.json` gained the entry. Drizzle finds migrations through the journal, so an SQL file without one never runs.

### PR Flow for Adding Tables

Two PRs, to avoid sync rule mismatches.

**PR 1: backend schema, migration and sync rules** (steps 2 and 4-6, plus the `backend/src/db/powersync-schema.ts` half of step 1). Merge, then run the migration. `.github/workflows/images-publish.yml` rebuilds `thunderbolt-powersync` with the new rules baked in. **Roll the Render `powersync` service to the new tag** (dashboard > Manual Deploy > Deploy latest reference) before merging PR 2; preview stacks pick it up on their next Pulumi apply.

**PR 2: frontend** (`src/db/tables.ts`, step 3, plus DAL, defaults, reconciliation, UI). Merge only after PR 1's image is live. Frontend-first fails silently: the table works locally but never replicates.

### Adding Columns to an Existing Synced Table

Sync rules are all `SELECT *`, so no rule edit is needed, but the column replicates only after the migration runs against the database `powersync` replicates from. Frontend-first leaves it null across devices while local tests pass. One PR is fine (e.g. `devices.node_id`) if the feature tolerates null; still run the migration before relying on it cross-device.

### Removing a Synced Table

Reverse of the add flow, plus one easily missed rule: **move the name from `powersyncTableNames` to `legacyPowerSyncTableNames` in [shared/powersync-tables.ts](../../shared/powersync-tables.ts) rather than deleting it, and never re-add it.** `backend/src/dal/powersync.ts` builds `legacyTables` from that list so `applyOperation` accepts-and-ignores its upload ops. Without the entry, `PUT /powersync/upload` answers **400** `UPLOAD_OPERATION_FAILED` and PowerSync retries forever, permanently wedging the CRUD queue of any device that queued a write before the drop so it uploads nothing else.

Then drop its line from all three sync-rule configs and remove it from `src/db/tables.ts` and `src/db/powersync/schema.ts`. Dropping the Postgres table is a separate retention question.

On the legacy list today: `modes` (THU-739) and `project_files`, which never reached production but ran long enough on preview stacks and local branches to leave queued writes behind.

---

## 3. Local Development (PowerSync Docker)

Full steps: [powersync-service/README.md](../../powersync-service/README.md).

- `make up` from the repo root (or `docker compose up -d` in `powersync-service/`)
- PowerSync API: http://localhost:8080 · Postgres: localhost:5433 (point the backend here so both share one database)
- Backend `.env`: `DATABASE_DRIVER=postgres`, `DATABASE_URL=postgresql://postgres:postgres@localhost:5433/postgres`, plus the vars below
- `powersync-service/config/config.yaml` sync rules must match backend tables. The upload validator (`validTables` in `backend/src/dal/powersync.ts`) derives from `powersyncTableNames` automatically.

```bash
POWERSYNC_URL=http://localhost:8080
POWERSYNC_JWT_SECRET=powersync-dev-secret-change-in-production
POWERSYNC_JWT_KID=powersync-dev
POWERSYNC_TOKEN_EXPIRY_SECONDS=3600
```

The local `config/config.yaml` uses HS256 with the same secret (base64) and kid, so backend-issued tokens are accepted.

---

## 4. Account Deletion

`DELETE /v1/account` hard-deletes the `user` row ([backend/src/dal/users.ts](../../backend/src/dal/users.ts)); synced tables cascade on `user_id`. A later token request for a session whose user is gone answers **410 Gone** `ACCOUNT_DELETED`, which is how the other devices find out. One of the sanctioned hard deletes (policy in [AGENTS.md](../../AGENTS.md)); the frontend only triggers it, and the UI and per-device behavior are in [Delete Account](delete-account-and-revoke-device.md#delete-account).

---

## 5. Device Management

### Devices Table

Defined in [backend/src/db/powersync-schema.ts](../../backend/src/db/powersync-schema.ts), mirrored in [src/db/tables.ts](../../src/db/tables.ts) with booleans as SQLite integers and without `app_version` (server-written for operators, never read back).

| Column                           | Meaning                                                                                     |
| -------------------------------- | ------------------------------------------------------------------------------------------- |
| `id`, `user_id`                  | device id and owner; the `bridge-` and `cli-` id namespaces are server-reserved             |
| `name`, `app_version`            | from `X-Device-Name` and `X-App-Version` on the token request, length-capped                |
| `last_seen`, `created_at`        | `last_seen` refreshed by `upsertDevice` on every token request; `created_at` only on insert |
| `trusted`, `approval_pending`    | drive the approve/deny queue in Settings > Devices                                          |
| `public_key`, `mlkem_public_key` | public keys for envelope wrapping ([e2e-encryption.md](e2e-encryption.md))                  |
| `revoked_at`                     | soft revoke; set by the revoke route, never cleared                                         |
| `device_type`                    | `normal`, `bridge` or `cli`, one shared revocation lifecycle                                |
| `node_id`, `node_id_attested_at` | iroh P2P identity, written only by the section 6 routes, never by a sync upload             |

**There is no `status` column.** State is three independent fields, so every check spells out the combination:

| State            | Condition                                                             |
| ---------------- | --------------------------------------------------------------------- |
| Pending approval | `trusted = false AND approval_pending = true AND revoked_at IS NULL`  |
| Trusted          | `trusted = true AND revoked_at IS NULL`                               |
| Denied           | `trusted = false AND approval_pending = false AND revoked_at IS NULL` |
| Revoked          | `revoked_at IS NOT NULL`                                              |

Bridge and CLI rows share the shape and lifecycle, so the DAL guards carry the distinction: `markDeviceTrusted`, `denyDevice` and `setDeviceNodeId` exclude `cli` rows, and `getPendingDevices` ([src/dal/devices.ts](../../src/dal/devices.ts)) offers only `normal` ones for approval (a null `device_type`, synced before the column shipped, counts as normal).

Trust-sensitive columns are server-managed. `revoked_at`, `trusted`, `approval_pending`, `public_key`, `mlkem_public_key`, `app_version`, `device_type`, `node_id` and `node_id_attested_at` sit in `uploadDenyColumns`, stripped from any `PUT`/`PATCH`; `devices` sits in `uploadDenyDelete`, so a sync `DELETE` is rejected and a row goes only through the section 6 route ([backend/src/dal/powersync.ts](../../backend/src/dal/powersync.ts), full gate in [powersync-upload-authorization.md](powersync-upload-authorization.md)). How `trusted`, `approval_pending` and `public_key` feed encryption setup and device approval: [e2e-encryption.md](e2e-encryption.md).

Three routes write `node_id` / `node_id_attested_at`: canary-gated `POST /devices/:deviceId/node-id`, session-pinned `POST /devices/me/node-id`, and bridge registration (`registerBridgeDevice`). Revoke and deny clear them so a removed device stops being dialable.

### Settings > Devices

Device list, pending-approval queue, revoke/remove buttons and pairing-identity dialog: [Settings > Devices Page](delete-account-and-revoke-device.md#settings--devices-page), [revoke flow](delete-account-and-revoke-device.md#revoke-device), routes in section 6.

### CLI Devices

Account-first onboarding, stable `cli-<uuid>` installation; contract in [CLI Device Registration and Logout](#cli-device-registration-and-logout).

- Account/revocation records, not PowerSync clients. The backend rejects `cli-` IDs from token and upload flows, and the namespace is server-reserved, so a `device_type = 'cli'` row cannot reach them under another ID.
- Provider profiles, model selection, account tokens and confidential cache material stay in the CLI's local state root and never sync.
- A trusted web device can revoke a CLI device from the regular list; the revoked CLI loses the bound session and must log in through the web again.
- `THUNDERBOLT_TOKEN` is separate: headless direct managed inference only, not device-bound, revoked through the PAT lifecycle rather than CLI logout.
- Confidential models need a web session unless the operator sets `CONFIDENTIAL_API_KEYS_ENABLED=true`; otherwise a PAT request fails `WEB_LOGIN_REQUIRED`, no fallback or replay. Why that gate is an authorization choice rather than a property of the confidential transport: [backend/docs/pat-lifecycle.md](../../backend/docs/pat-lifecycle.md).

### Auth Token and Device ID

Both live in `localStorage` under fixed keys ([src/lib/auth-token.ts](../../src/lib/auth-token.ts)).

- **Auth token:** fixed key so `getAuthToken()` stays synchronous, as Better Auth requires. Not synced. Cleared by `clearAuthToken()` on session expiry, or via `clearLocalData()` for a full reset. Nothing calls `localStorage.clear()`.
- **Device id:** created on first read, sent as `X-Device-ID` with `X-Device-Name` on PowerSync requests so the backend can register or update the row and enforce revocation. A missing name becomes `Unknown device`.

---

## 6. Backend API

### PowerSync Token (`GET /powersync/token`)

- **Session path:** `validateDeviceForSync` validates, then the route issues a JWT and upserts the device (id, user_id, name, last_seen, `app_version` from `X-App-Version`).
- **Bearer token only (e.g. credential refresh):** the signed token resolves to a persisted session. A missing user row (account deleted) gives **410 Gone** `ACCOUNT_DELETED`; otherwise validation and issuance run as above.
- `X-Device-ID` is required on both paths, so a revoked device cannot buy a token by omitting the header.
- With `POWERSYNC_JWT_SECRET` unset, `createPowerSyncRoutes` returns an empty Elysia instance and mounts neither route, so requests 404. Secret set, `POWERSYNC_URL` empty: `/token` answers **503**.

### PowerSync Upload (`PUT /powersync/upload`)

- Requires an authenticated, non-anonymous user, an `X-Device-ID` header and the same `validateDeviceForSync`, except that the device must already exist. Only the token route creates one (`allowNewDevice: true`), and only while E2EE is off: with E2EE on, a device that has not been through the envelope flow is untrusted and rejected.
- A rejected operation returns **400** `UPLOAD_OPERATION_FAILED` deliberately, so the client skips `transaction.complete()` and PowerSync retries the batch. Ops for a `legacyPowerSyncTableNames` table are accepted and ignored instead (see [Removing a Synced Table](#removing-a-synced-table)).

Both routes answer **403** `ORIGIN_NOT_ALLOWED` for a cross-origin request whose `Origin` is not in the CORS set; an absent `Origin` (non-browser clients) is allowed.

Only rows with a client reason change app state ([src/db/powersync/connector.ts](../../src/db/powersync/connector.ts) maps status and code to a `CredentialsInvalidReason`, section 7). Otherwise `fetchCredentials` returns `null` and PowerSync retries on its own schedule.

| Status | Code                       | Meaning                                                           | Client reason                          |
| ------ | -------------------------- | ----------------------------------------------------------------- | -------------------------------------- |
| 410    | `ACCOUNT_DELETED`          | the user row is gone                                              | `account_deleted`: full reset          |
| 403    | `DEVICE_DISCONNECTED`      | `revoked_at` is set on this device                                | `device_revoked`: revoked-device modal |
| 403    | `DEVICE_NOT_TRUSTED`       | a `cli-` prefixed id, or (E2EE on) an unknown or untrusted device | none (expected while approval pends)   |
| 403    | `ANONYMOUS_SYNC_FORBIDDEN` | anonymous session                                                 | `sync_not_permitted`: sync disabled    |
| 403    | `ORIGIN_NOT_ALLOWED`       | `Origin` outside the CORS allowlist                               | none                                   |
| 409    | `DEVICE_ID_TAKEN`          | the id is registered to another user                              | `device_id_taken`: full reset          |
| 400    | `DEVICE_ID_REQUIRED`       | no `X-Device-ID` header                                           | `device_id_required`: full reset       |
| 401    | (none)                     | missing, unsigned, or expired bearer token                        | `session_expired`: sign-in modal       |
| 503    | (none)                     | `/token` only: secret set but `POWERSYNC_URL` empty               | none                                   |

### Revoke Device (`POST /v1/account/devices/:id/revoke`)

- Requires an authenticated session and an `X-Device-ID` header naming the **calling** device (**400** without it).
- With encryption metadata on the account, revocation also requires proof the caller holds the Content Key, so a stolen session cannot evict the legitimate devices. Both checks answer **403** and an account with no metadata skips them:
  - `canarySecret` (body, `maxLength: 500`) must be present and verify against the stored hash. The check keys on the metadata row's presence rather than on `canarySecretHash`, so a null hash fails closed instead of skipping the gate.
  - The calling device must be trusted, non-revoked, and `device_type = 'normal'`.
- Transactional under the per-account advisory lock: `deleteEnvelope`, `revokeDevice`, `revokeDeviceSessions` (the last only if `revokeDevice` matched a row).
- **204** on success, idempotent: an already-revoked device matches nothing and its sessions are left alone.

Deleting the envelope makes revocation durable: the wrapped Content Key is gone, so the CK stays unrecoverable even if the device's private key leaks. Nulling `node_id` de-authorizes the device on the iroh path, since `GET /v1/devices/allowlist` returns only trusted, non-revoked, non-CLI `node_id`s and a running bridge refreshes it on a 45-second membership heartbeat, tearing down sessions whose peer dropped off ([cli/src/iroh/bridge.ts](../../cli/src/iroh/bridge.ts), [cli/src/iroh/account-allowlist.ts](../../cli/src/iroh/account-allowlist.ts)).

### Remove Device (`DELETE /v1/devices/:deviceId`)

A hard delete, deliberately narrow: only a **revoked bridge** device (**409** otherwise, **404** if not the caller's). Revokes the device's sessions, then deletes the row. It exists because bridge registration refuses to resurrect a revoked bridge row with the same NodeId, so the tombstone must be cleared before pairing again ([backend/src/api/encryption.ts](../../backend/src/api/encryption.ts)).

### CLI Device Registration and Logout

- `PUT /v1/account/devices/cli` needs a valid non-anonymous persisted web session plus canonical CLI device, device-name and app-version headers. Registers or touches the installation and binds that session to the device.
- `POST /v1/account/devices/cli/logout` is remote-first: revokes the bound CLI device and all its sessions, then **204**.
- Revoked devices return `DEVICE_DISCONNECTED`; invalid or expired sessions return **401**. Clients do not replay a failed inference request after login.

### Managed Catalog Privacy

`GET /v1/config` publishes managed models through `defaults.models`: versioned `SharedModel` rows without `apiKey`, plus `defaultModelId`. Price tables, quota internals, credentials and other deployment secrets stay backend-only. Mandatory old-client-safe rollout order: [CLI Device Rollout](../self-hosting/configuration.md#cli-device-rollout).

### Encryption API Endpoints

Encryption setup, device approval, iroh pairing, key recovery. Mounted on `/v1` without a sub-prefix (unlike the account routes above), so full paths are `/v1/devices/…` and `/v1/encryption/canary`. All need an authenticated session; several also need canary proof of CK possession. Defined in `backend/src/api/encryption.ts`; key hierarchy in [e2e-encryption.md](e2e-encryption.md).

| Route                              | Purpose                                                                                         |
| ---------------------------------- | ----------------------------------------------------------------------------------------------- |
| `POST /devices`                    | Register a device with its public key (encryption setup)                                        |
| `POST /devices/:deviceId/envelope` | Store a wrapped content key; also marks the target device trusted                               |
| `GET /devices/me/envelope`         | Fetch this device's own wrapped content key                                                     |
| `GET /encryption/canary`           | Fetch the canary used to verify a recovery key                                                  |
| `POST /devices/:deviceId/deny`     | Deny a pending device; requires `canarySecret`                                                  |
| `POST /devices/me/cancel-pending`  | Withdraw this device's own pending request; `X-Device-ID`, no canary                            |
| `POST /devices/:deviceId/node-id`  | Attest another device's iroh `node_id`; requires `canarySecret`                                 |
| `POST /devices/me/node-id`         | Self-enroll this device's own `node_id`; no canary, it can only bind its own row                |
| `GET /devices/allowlist`           | Trusted, non-revoked `node_id`s on the account (the bridge's peer allowlist)                    |
| `POST /devices/bridge`             | Register an ACP/MCP bridge; the only way to create a `device_type = 'bridge'` row               |
| `DELETE /devices/:deviceId`        | Hard-delete a revoked bridge row (see [Remove Device](#remove-device-delete-v1devicesdeviceid)) |

---

## 7. Frontend: Credentials-Invalid and Reset

`getCredentialsInvalidReason` ([src/db/powersync/connector.ts](../../src/db/powersync/connector.ts)) turns the status and code above into one of six reasons, each given a different consequence by `usePowerSyncCredentialsInvalidListener` ([src/hooks/use-powersync-credentials-invalid-listener.ts](../../src/hooks/use-powersync-credentials-invalid-listener.ts)). Only three destroy local data: a session expiry or device revocation must not cost the user their offline database. A seventh path watches the current device's synced `devices` row, so a revocation lands without waiting for the next token refresh.

Per-reason consequences, the watcher's cold-start guard, what `clearLocalData` ([src/lib/cleanup.ts](../../src/lib/cleanup.ts)) tears down, and a side-by-side of both flows: [delete-account-and-revoke-device.md](delete-account-and-revoke-device.md#frontend).
