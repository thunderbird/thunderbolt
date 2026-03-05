# PowerSync, Account & Device Management

This document consolidates documentation for:

- **PowerSync**: multi-device sync (synced tables, local dev, adding tables)
- **Account**: deletion flow and how other devices reset
- **Devices**: registration, list, revoke, and how a revoked device resets

---

## 1. PowerSync overview

PowerSync provides offline-first sync between the backend (PostgreSQL) and clients (SQLite). Data is scoped by `user_id` from the JWT. The backend issues PowerSync JWTs and can apply client uploads (PUT/PATCH/DELETE) to Postgres. Production uses PowerSync Cloud; local development uses the Docker stack in `powersync-service/`.

For the sync data transformation middleware and custom SharedWorker (E2E encryption pipeline), see [docs/powersync-sync-middleware.md](powersync-sync-middleware.md).

---

## 2. Synced tables

### Requirements

- Every synced table must have a **`user_id`** column (sync rules and backend scope by `user_id`).
- Define the table in **both**:
  - Frontend: [src/db/tables.ts](src/db/tables.ts) (SQLite)
  - Backend: [backend/src/db/powersync-schema.ts](backend/src/db/powersync-schema.ts) (PostgreSQL)
- **Backend schema uses minimal indexes**: Only primary keys and `user_id` indexes (see [Indexes and Foreign Keys](#indexes-and-foreign-keys) below).

### Current tables

Defined in [shared/powersync-tables.ts](shared/powersync-tables.ts):

`settings`, `chat_threads`, `chat_messages`, `tasks`, `models`, `mcp_servers`, `prompts`, `triggers`, `modes`, `model_profiles`, `devices`.

### Indexes and foreign keys

**Backend (PostgreSQL) uses a minimal index strategy:**

- ✅ Primary keys (required)
- ✅ Single `user_id` index on every table (required for PowerSync sync rules)
- ❌ No composite foreign key constraints
- ❌ No active indexes (`WHERE deletedAt IS NULL`)
- ❌ No foreign key indexes

**Rationale:** The backend is primarily a sync server, not a query engine. Complex queries and JOINs happen on the frontend (SQLite). With E2E encryption planned, backend indexes on encrypted data would be useless. Minimal indexes reduce storage overhead and improve write performance during sync operations.

**Frontend (SQLite) can use any indexes needed** for local query optimization since queries happen there.

See [docs/composite-primary-keys-and-default-data.md](composite-primary-keys-and-default-data.md) for detailed explanation.

### Adding a new synced table

1. Create the table in both `src/db/tables.ts` and `backend/src/db/powersync-schema.ts` (include `user_id`).
2. **Backend schema**: Add only a `user_id` index: `index('idx_[table]_user_id').on(table.userId)`. Do not add composite foreign keys or other indexes (see above).
3. Register in [src/db/powersync/schema.ts](src/db/powersync/schema.ts) (`drizzleSchema`).
4. Add the table name and query keys in [shared/powersync-tables.ts](shared/powersync-tables.ts) (`POWERSYNC_TABLE_NAMES` and `powersyncTableToQueryKeys`).
5. Update [powersync-service/config/config.yaml](powersync-service/config/config.yaml): add a line under `sync_rules.content` → `bucket_definitions.user_data.data` (e.g. `- SELECT * FROM my_table WHERE my_table.user_id = bucket.user_id`).
6. Run migrations for frontend and backend as needed.

### PR flow for adding tables

Split the work into two PRs to avoid sync rule mismatches:

1. **PR 1 – Backend schemas and migrations**
   - Backend: table in `backend/src/db/powersync-schema.ts`, migration, `shared/powersync-tables.ts`, `config.yaml` sync rules.
   - Merge this PR first.
   - After deploy finishes, update sync rules in the PowerSync Cloud dashboard (production uses PowerSync Cloud; local uses `powersync-service` config).

2. **PR 2 – Frontend and remaining changes**
   - Frontend: table in `src/db/tables.ts`, `src/db/powersync/schema.ts`, and any UI/feature code.
   - Merge after PR 1 is deployed and PowerSync rules are updated.

---

## 3. Local development (PowerSync Docker)

See [powersync-service/README.md](../powersync-service/README.md) for full steps. Summary:

- From `powersync-service/`: `docker compose up -d`
- PowerSync API: http://localhost:8080
- Postgres: localhost:5433 (use this for the backend so PowerSync and app share one database)
- Backend `.env`: set `DATABASE_DRIVER=postgres`, `DATABASE_URL=postgresql://postgres:postgres@localhost:5433/postgres`, and PowerSync vars (see below)
- Sync rules in `powersync-service/config/config.yaml` must match backend tables; when you add/change tables, update that file and `VALID_TABLES` in `backend/src/api/powersync.ts` (which uses `POWERSYNC_TABLE_NAMES` from shared).

### Backend PowerSync env vars (local)

```env
POWERSYNC_URL=http://localhost:8080
POWERSYNC_JWT_SECRET=powersync-dev-secret-change-in-production
POWERSYNC_JWT_KID=powersync-dev
POWERSYNC_TOKEN_EXPIRY_SECONDS=3600
```

The local `config/config.yaml` uses HS256 with the same secret (base64) and kid so backend-issued tokens are accepted.

---

## 4. Account deletion

- **Where:** Settings > Preferences → “Delete my account” (with confirmation).
- **Request:** Frontend calls `DELETE /v1/account` with the current auth token.
- **Backend:** Deletes the user and all related data (settings, chats, models, devices, etc.).
- **Other devices:** When PowerSync refreshes the token, the backend returns **410 Gone** with `code: 'ACCOUNT_DELETED'`. The app treats this as credentials invalid and runs the reset flow (see section 7).

---

## 5. Device management

### Devices table

- **Backend:** `devices` table: `id`, `user_id`, `name`, `last_seen`, `created_at`, `revoked_at`. Synced via PowerSync.
- **Frontend:** Same schema in the local DB; used for Settings > Devices and for “current device revoked?” checks.

### Listing devices

- **Where:** Settings > Devices.
- **Data:** Devices from the local DB (synced `devices` table) via `getAllDevices()` and React Query key `['devices']`.
- **UI:** Name, last seen, “This device” for current device, “Revoked” when `revoked_at` is set. “Revoke” only for other, non-revoked devices.

### Revoking a device

1. User chooses “Revoke” on another device (with confirmation). Frontend calls `POST /v1/account/devices/:id/revoke`.
2. Backend sets `revoked_at` on that device row (soft revoke). PowerSync syncs the updated `devices` table.
3. On the **revoked device**:
   - **Immediate:** The app watches the current device’s row via React Query (`getDevice(deviceId)`). When the synced row has `revoked_at` set, the app runs the reset flow.
   - **On token refresh:** Backend returns **403 Forbidden** with `code: 'DEVICE_DISCONNECTED'`; the connector dispatches credentials invalid and the app resets.

### Auth token and device id

- **Auth token:** In `localStorage` (fixed key). Cleared on reset via `localStorage.clear()`.
- **Device id:** In `localStorage`. Sent as `X-Device-ID` (and optional `X-Device-Name`) on PowerSync token requests so the backend can register/update the device and enforce revoke.

---

## 6. Backend API

### PowerSync token (`GET /powersync/token`)

- **With `X-Device-ID`:**
  - Backend checks the `devices` row for that id. If `revoked_at` is set → **403** with `{ code: 'DEVICE_DISCONNECTED' }`, no token.
  - Otherwise: issues a PowerSync JWT and upserts the device (id, user_id, name, last_seen, created_at).
- **Bearer token only (e.g. credential refresh):**
  - If the user no longer exists (account deleted) → **410 Gone** with `{ code: 'ACCOUNT_DELETED' }`.
  - Otherwise may return **401** (invalid/expired token).

### PowerSync upload (`PUT /powersync/upload`)

- Requires authenticated user and `X-Device-ID` header.
- Same device validation as token: if device is revoked → **403** with `{ code: 'DEVICE_DISCONNECTED' }`. If `X-Device-ID` is missing → **400** with `{ code: 'DEVICE_ID_REQUIRED' }`.
- Only non-revoked devices can upload data.

Summary for client:

- **410** → account deleted (reset).
- **403** with `DEVICE_DISCONNECTED` → this device revoked (reset).
- **409** with `DEVICE_ID_TAKEN` → device id already registered to another user; reset to get a fresh device id.
- **401** → generic auth failure.

### Revoke device (`POST /v1/account/devices/:id/revoke`)

- Requires authenticated user (session).
- Sets `revoked_at` to current timestamp for the device `id` that belongs to the current user.
- **204** on success (idempotent for already-revoked devices).

---

## 7. Frontend: credentials-invalid and reset

When the app should reset (account deleted or device revoked), it runs a single flow:

1. `setSyncEnabled(false)` – disconnect from PowerSync.
2. `localStorage.clear()` – remove auth token and device id.
3. `resetAppDir()` – clear the app directory (DB and related files).
4. `window.location.reload()` – reload to a clean, signed-out state.

Triggered in two ways:

1. **Event `powersyncCredentialsInvalid`**  
   Dispatched when the token request returns **410** or **403** with body `code: 'DEVICE_DISCONNECTED'`.
2. **Devices table (current device revoked)**  
   `usePowerSyncCredentialsInvalidListener` uses React Query `getDevice(deviceId)` and key `['devices', deviceId]`. When the synced `devices` row has `revoked_at` set for the current device, the hook runs the same reset flow (immediate, without waiting for next token refresh).

After revoke, the Settings > Devices list is updated by invalidating `['devices']` so the list reflects the new state after sync.

---

## 8. Summary

| Action         | Where       | Backend / sync behavior                        | Other device behavior                                                             |
| -------------- | ----------- | ---------------------------------------------- | --------------------------------------------------------------------------------- |
| Delete account | Preferences | User and data deleted; 410 on token refresh    | Reset when 410 received or when sync reflects deletion                            |
| Revoke device  | Devices     | Set `revoked_at`; 403 on that device’s refresh | Revoked device resets when it sees `revoked_at` (useQuery) or gets 403 on refresh |

Both paths use the same reset: disable sync, clear localStorage, reset app dir, reload.
