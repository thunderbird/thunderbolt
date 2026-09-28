# PowerSync Upload Authorization

[`applyOperation`](../../../backend/src/dal/powersync.ts) is the only server-side authorization a client write passes through: it decides which uploaded operations are accepted and which of their columns apply.

## Two credentials, two directions

| Direction | Endpoint                                  | Credential                                     | Isolation mechanism                                                                      |
| --------- | ----------------------------------------- | ---------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Download  | The PowerSync service's own sync stream   | Short-lived JWT from `GET /v1/powersync/token` | Sync rules: every bucket is `... WHERE user_id = bucket.user_id` off `request.user_id()` |
| Upload    | `PUT /v1/powersync/upload` on the backend | The ordinary app session                       | `applyOperation` (this document)                                                         |

- Upload resolves its user with `auth.api.getSession` in the Elysia `.derive` ([backend/src/api/powersync.ts:173-179](../../../backend/src/api/powersync.ts)); the PowerSync JWT plays no part in a write.
- The download-side sync rules are duplicated across three configs ([powersync-service/config/config.yaml](../../../powersync-service/config/config.yaml), [deploy/config/powersync-config.yaml](../../../deploy/config/powersync-config.yaml), [deploy/k8s/templates/configmaps.yaml](../../../deploy/k8s/templates/configmaps.yaml)), so nothing in `backend/` enforces read isolation.
- Uploads arrive as generic row operations (table name, row id, bag of columns) assembled on a device the user controls, so none of it is trustworthy.
- The endpoint around the gate (origin check, anonymous rejection, device validation, reset status codes) is in [powersync-account-devices.md](powersync-account-devices.md#powersync-upload-put-powersyncupload).

## The gate, in order

`applyOperation(database, op, userId)` takes `userId` from the authenticated session, never from the payload.

1. **Legacy table, accept and ignore** ([:100](../../../backend/src/dal/powersync.ts)). A name in `legacyPowerSyncTableNames` ([shared/powersync-tables.ts:38](../../../shared/powersync-tables.ts)) returns `true` without touching the database.

   A dropped table stays listed forever: rejecting it 400s the batch, PowerSync retries indefinitely, and one queued write for a removed table stops that device uploading again (THU-739). See [Removing a Synced Table](powersync-account-devices.md#removing-a-synced-table).

2. **Unknown table, reject** ([:104](../../../backend/src/dal/powersync.ts)). `validTables` is built from `powersyncTableNames`, so the allowlist cannot drift from the synced schema.

3. **Schema lookup** ([:108-115](../../../backend/src/dal/powersync.ts)). Drizzle table, column-name map, primary key and conflict target come from `Record<PowerSyncTableName, …>` maps in [backend/src/db/powersync-schema.ts](../../../backend/src/db/powersync-schema.ts), so a missing entry is a compile error.

4. **Reserved device-id namespaces, reject** ([:48](../../../backend/src/dal/powersync.ts), applied at `:117`). A `devices` row whose id starts with `bridge-` or `cli-` is owned by a server route (`POST /v1/devices/bridge`, `PUT /v1/account/devices/cli`), and is reserved from _every_ operation, not just inserts: a client cannot squat a deterministic bridge id or rename a CLI row.

5. **Strip what the client may not set.** `id` and `user_id` are deleted from the payload, then every entry in `uploadDenyColumns` for that table ([:21-39](../../../backend/src/dal/powersync.ts), applied at `:129` and `:162`), then every column the Drizzle table does not have, inside `toSchemaRecord` ([:65](../../../backend/src/dal/powersync.ts)).

6. **Stamp identity from the session.** A `PUT` rebuilds the record as `{ ...payload, id: op.id, user_id: userId }` ([:132](../../../backend/src/dal/powersync.ts)), overwriting a spoofed `id` or `user_id` rather than ignoring it. A `PATCH` carries neither column (stripped in step 5) and is located by primary key.

7. **Coerce timestamps.** Columns in `timestampDbColumns` ([:59](../../../backend/src/dal/powersync.ts)) arrive as ISO strings and become `Date` for Drizzle; an unparseable string passes through unchanged rather than becoming an epoch date.

8. **Scope the row to the owner.** The upsert's `onConflictDoUpdate` carries `setWhere: eq(userId, ...)`; `PATCH` and `DELETE` put the same equality in the `WHERE`. `chat_threads`, `chat_messages`, `triggers`, `devices` and `projects` have a global `id` primary key (see [composite-primary-keys-and-default-data.md](composite-primary-keys-and-default-data.md)), so without it a guessed id is a cross-account write; with it, the conflicting insert matches zero rows and the other user's row is untouched.

9. **Refuse deletes on protected tables** ([:184](../../../backend/src/dal/powersync.ts)). `uploadDenyDelete` holds `devices`: removal goes through `POST /v1/account/devices/:id/revoke`, which also drops the device's envelope and sessions.

## Who owns a `devices` column

Every denied column is written by server code only, each by a small fixed set of writers.

| Column                           | Written by                                                                                                                                                                                                                    |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `public_key`, `mlkem_public_key` | `registerDevice`, on `POST /v1/devices` ([backend/src/api/encryption.ts](../../../backend/src/api/encryption.ts)); the only route that sets a key value                                                                       |
| `trusted`, `approval_pending`    | `registerDevice` (pending), `markDeviceTrusted`, `denyDevice` and `revokeDevice` ([backend/src/dal/devices.ts](../../../backend/src/dal/devices.ts)); also auto-trusted by `upsertDevice` on the token route when E2EE is off |
| `revoked_at`                     | `revokeDevice` only, via `POST /v1/account/devices/:id/revoke`                                                                                                                                                                |
| `app_version`                    | `upsertDevice` from the `X-App-Version` header on the token route, and `upsertCliDevice` on CLI registration                                                                                                                  |
| `device_type`                    | The bridge and CLI registration routes; `normal` is the column default, so any other upsert produces one. Discriminates a bridge from a normal device and drives the account allowlist                                        |
| `node_id`, `node_id_attested_at` | The canary-gated `POST /v1/devices/:deviceId/node-id`, the session-pinned `POST /v1/devices/me/node-id`, and bridge registration; revoke, deny and re-registration clear them                                                 |

Only `name`, `last_seen` and `created_at` stay client-writable on a device's own row, which is what makes `devices` safe to sync. Under E2EE `name` arrives as ciphertext: `devices.name` is in `encryptedColumnsMap` ([src/db/encryption/config.ts](../../../src/db/encryption/config.ts)) and `encodeForUpload` encrypts it in the connector.

See also [e2e-encryption.md](e2e-encryption.md) (server-set `device_type` is load-bearing for the bridge allowlist) and [delete-account-and-revoke-device.md](delete-account-and-revoke-device.md) (the revoke path the delete ban forces writes through).

## What a rejection costs

The route applies operations one at a time and turns the first `false` from `applyOperation` into a **400** `UPLOAD_OPERATION_FAILED` ([backend/src/api/powersync.ts:274-291](../../../backend/src/api/powersync.ts)), so the client never calls `transaction.complete()` and PowerSync retries the whole batch.

Nothing wraps the batch in a transaction: earlier operations are already committed and the retry replays them. Every operation must be safe to apply twice, and a deterministic `false` is a queue that never drains.

It returns `true` for the "nothing to do" cases:

- an op for a legacy table ([:100](../../../backend/src/dal/powersync.ts));
- a `PATCH` with no `data`, or empty `data` ([:156](../../../backend/src/dal/powersync.ts));
- a `PATCH` left empty after stripping unknown and server-managed columns ([:165-172](../../../backend/src/dal/powersync.ts)), so `{ user_id }` alone cannot wedge every write behind it;
- a `PUT` with nothing left once `id`, `key` and `user_id` leave the update set: falls back to `onConflictDoNothing`, leaving the existing row intact ([:151](../../../backend/src/dal/powersync.ts)).

Every branch is pinned in [backend/src/dal/powersync.test.ts](../../../backend/src/dal/powersync.test.ts), cross-user isolation included.

## What will bite you

**A new server-managed column is silent privilege escalation unless you add it to `uploadDenyColumns`.** The list is plain strings in a `Partial<Record<…>>`: nothing type-checks it, nothing fails if a column is missing, and the column is simply client-writable with no signal but a test you write yourself. If a column means "the server verified something", deny-list it in the same commit.

**An unknown column is dropped, not rejected.** `toSchemaRecord` filters against the Drizzle table's column names, so a frontend-schema column not yet migrated into Postgres uploads cleanly and vanishes: local tests pass, the value is null on every other device. See [Adding Columns to an Existing Synced Table](powersync-account-devices.md#adding-columns-to-an-existing-synced-table).

**Step 8 is the only cross-account guard for a table with a global `id` primary key.** Weakening the `setWhere` / `WHERE user_id` clause breaks no types.

## Where the code lives

| File                                                                                | Role                                                                   |
| ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| [backend/src/dal/powersync.ts](../../../backend/src/dal/powersync.ts)               | The gate: allowlists, deny lists, reserved ids, `applyOperation`       |
| [backend/src/dal/powersync.test.ts](../../../backend/src/dal/powersync.test.ts)     | Regression tests for every branch above                                |
| [backend/src/api/powersync.ts](../../../backend/src/api/powersync.ts)               | The `/token` and `/upload` routes, device validation, origin check     |
| [backend/src/db/powersync-schema.ts](../../../backend/src/db/powersync-schema.ts)   | Drizzle tables plus the pk / conflict-target / column-name maps        |
| [shared/powersync-tables.ts](../../../shared/powersync-tables.ts)                   | `powersyncTableNames` and `legacyPowerSyncTableNames`                  |
| [src/db/powersync/connector.ts](../../../src/db/powersync/connector.ts)             | `uploadData`: builds the batch, maps error responses to client actions |
| [src/db/encryption/upload-encoder.ts](../../../src/db/encryption/upload-encoder.ts) | Encrypts encrypted columns before the batch leaves the device          |
