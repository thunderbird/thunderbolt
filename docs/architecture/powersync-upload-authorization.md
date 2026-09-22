# PowerSync Upload Authorization

Every synced write begins in the client's own SQLite and reaches the server as a generic row operation: a table name, a row id, and a bag of columns. Nothing about that shape is trustworthy — the payload is assembled on a device the user controls, and PowerSync's CRUD queue will happily carry whatever was written locally. [`applyOperation`](../../backend/src/dal/powersync.ts) is the single place that decides which of those writes the server accepts, and which columns of an accepted write it is willing to apply.

This document covers the per-operation gate. The endpoint around it — origin check, anonymous rejection, device validation, and the status codes the client maps to a reset — is in [powersync-account-devices.md](./powersync-account-devices.md#powersync-upload-put-powersyncupload).

## Two credentials, two directions

Reads and writes do not travel the same path, and they are not authorized by the same token.

| Direction | Endpoint                                  | Credential                                     | Isolation mechanism                                                                      |
| --------- | ----------------------------------------- | ---------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Download  | The PowerSync service's own sync stream   | Short-lived JWT from `GET /v1/powersync/token` | Sync rules: every bucket is `... WHERE user_id = bucket.user_id` off `request.user_id()` |
| Upload    | `PUT /v1/powersync/upload` on the backend | The ordinary app session                       | `applyOperation` — this document                                                         |

The upload route resolves its user with `auth.api.getSession` in the Elysia `.derive` ([backend/src/api/powersync.ts:173-179](../../backend/src/api/powersync.ts)); the PowerSync JWT plays no part in a write. The sync rules that scope the download side are duplicated across three configs — [powersync-service/config/config.yaml](../../powersync-service/config/config.yaml), [deploy/config/powersync-config.yaml](../../deploy/config/powersync-config.yaml), and [deploy/k8s/templates/configmaps.yaml](../../deploy/k8s/templates/configmaps.yaml) — so nothing in `backend/` enforces read isolation. The write gate is therefore the only server-side authorization a client write ever passes through.

## The gate, in order

`applyOperation(database, op, userId)` runs these checks in sequence. The `userId` argument comes from the authenticated session and is never read from the payload.

1. **Legacy table → accept and ignore** ([:100](../../backend/src/dal/powersync.ts)). A name in `legacyPowerSyncTableNames` ([shared/powersync-tables.ts:38](../../shared/powersync-tables.ts)) returns `true` without touching the database. A dropped table has to stay on that list forever: rejecting it would 400 the batch, and PowerSync retries a failed batch indefinitely, so a device holding one queued write for a removed table would stop uploading anything ever again (THU-739). See [Removing a Synced Table](./powersync-account-devices.md#removing-a-synced-table).
2. **Unknown table → reject** ([:104](../../backend/src/dal/powersync.ts)). `validTables` is built from `powersyncTableNames`, so the allowlist cannot drift from the synced schema.
3. **Schema lookup** ([:108-115](../../backend/src/dal/powersync.ts)). The Drizzle table, the column-name map, the primary key and the conflict target all come from `Record<PowerSyncTableName, …>` maps in [backend/src/db/powersync-schema.ts](../../backend/src/db/powersync-schema.ts), so a table missing an entry is a compile error rather than a runtime surprise.
4. **Reserved device-id namespaces → reject** ([:48](../../backend/src/dal/powersync.ts), applied at `:117`). A `devices` row whose id starts with `bridge-` or `cli-` is owned by a server route (`POST /v1/devices/bridge`, `PUT /v1/account/devices/cli`). Reserving both prefixes from _every_ operation — not just inserts — stops a client pre-creating a row to squat a deterministic bridge id, and stops it renaming or otherwise touching an existing CLI row.
5. **Strip what the client may not set.** `id` and `user_id` are deleted from the payload, then every entry in `uploadDenyColumns` for that table ([:21-39](../../backend/src/dal/powersync.ts), applied at `:129` and `:162`), then — inside `toSchemaRecord` ([:65](../../backend/src/dal/powersync.ts)) — every column name the Drizzle table does not have.
6. **Stamp identity from the session.** On a `PUT` the record is rebuilt as `{ ...payload, id: op.id, user_id: userId }` ([:132](../../backend/src/dal/powersync.ts)), so a spoofed `id` or `user_id` in `data` is overwritten rather than merely ignored. A `PATCH` never carries either column: both were stripped in step 5, and the row is located by primary key instead.
7. **Coerce timestamps.** JSON has no date type, so the columns in `timestampDbColumns` ([:59](../../backend/src/dal/powersync.ts)) arrive as ISO strings and are converted to `Date` for Drizzle. An unparseable string is passed through unchanged rather than being coerced to an epoch date.
8. **Scope the row to the owner.** The upsert's `onConflictDoUpdate` carries `setWhere: eq(userId, ...)`; `PATCH` and `DELETE` put the same equality in the `WHERE`. `chat_threads`, `chat_messages`, `triggers`, `devices` and `projects` have a global `id` primary key (see [composite-primary-keys-and-default-data.md](./composite-primary-keys-and-default-data.md)), so without that clause a guessed id would be a cross-account write. With it, the conflicting insert matches zero rows and the other user's row is untouched.
9. **Refuse deletes on protected tables** ([:184](../../backend/src/dal/powersync.ts)). `uploadDenyDelete` holds `devices`: a device record is an identity and revocation artefact, so removing one has to go through `POST /v1/account/devices/:id/revoke`, which also drops the device's envelope and its sessions.

## Who owns a `devices` column

The deny list is what makes the `devices` table safe to sync at all. Every protected column is written by server code only, and each has a small, fixed set of writers:

| Column                           | Written by                                                                                                                                                                                                                 |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `public_key`, `mlkem_public_key` | `registerDevice`, on `POST /v1/devices` ([backend/src/api/encryption.ts](../../backend/src/api/encryption.ts)) — the only route that sets a key value                                                                      |
| `trusted`, `approval_pending`    | `registerDevice` (pending), `markDeviceTrusted`, `denyDevice` and `revokeDevice` ([backend/src/dal/devices.ts](../../backend/src/dal/devices.ts)); also auto-trusted by `upsertDevice` on the token route when E2EE is off |
| `revoked_at`                     | `revokeDevice` only, via `POST /v1/account/devices/:id/revoke`                                                                                                                                                             |
| `app_version`                    | `upsertDevice` from the `X-App-Version` header on the token route, and `upsertCliDevice` on CLI registration                                                                                                               |
| `device_type`                    | The bridge and CLI registration routes; `normal` is the column default, so any other upsert produces one. It discriminates a bridge from a normal device and drives the account allowlist                                  |
| `node_id`, `node_id_attested_at` | The canary-gated `POST /v1/devices/:deviceId/node-id`, the session-pinned `POST /v1/devices/me/node-id`, and bridge registration; revoke, deny and re-registration clear them                                              |

What that leaves a client able to write on its own row is `name`, `last_seen` and `created_at`. With E2EE enabled, `name` is ciphertext by the time it arrives: `devices.name` is in `encryptedColumnsMap` ([src/db/encryption/config.ts](../../src/db/encryption/config.ts)) and `encodeForUpload` encrypts it in the connector before the request is built.

Two related facts live elsewhere: [e2e-encryption.md](./e2e-encryption.md) explains why `device_type` being server-set is load-bearing for the bridge allowlist, and [delete-account-and-revoke-device.md](./delete-account-and-revoke-device.md) covers the revoke path the delete ban forces writes through.

## Accept, reject, and the retry loop

`applyOperation` returns a boolean. The route applies operations one at a time and turns the first `false` into a **400** `UPLOAD_OPERATION_FAILED` ([backend/src/api/powersync.ts:274-291](../../backend/src/api/powersync.ts)), which stops the client calling `transaction.complete()` so PowerSync retries the whole batch.

There is no surrounding transaction: operations before the failing one have already been committed, and the retry replays them. Every operation therefore has to be safe to apply twice, and a deterministic `false` is not a diagnostic — it is a queue that never drains. That is why the gate distinguishes "not allowed" from "nothing to do" and returns `true` for the second case:

- an op for a legacy table ([:100](../../backend/src/dal/powersync.ts));
- a `PATCH` with no `data`, or whose `data` is empty ([:156](../../backend/src/dal/powersync.ts));
- a `PATCH` left empty after stripping unknown and server-managed columns ([:165-172](../../backend/src/dal/powersync.ts)) — a buggy client sending only `{ user_id }` must not wedge every write behind it;
- a `PUT` whose payload has nothing left to update once `id`, `key` and `user_id` are removed from the update set, which falls back to `onConflictDoNothing` so an existing row is left intact ([:151](../../backend/src/dal/powersync.ts)).

The behaviour of each of these branches, including the cross-user isolation cases, is pinned in [backend/src/dal/powersync.test.ts](../../backend/src/dal/powersync.test.ts).

## What will bite you

**Adding a server-managed column to a synced table is silent privilege escalation unless you add it to `uploadDenyColumns`.** `uploadDenyColumns` is a `Partial<Record<…>>` of plain strings — nothing type-checks that a sensitive column appears in it, and nothing fails if it does not. The column simply becomes client-writable, and the only signal is a test you would have to write. If a column's value means "the server has verified something", it belongs on the deny list in the same commit that adds it.

**An unknown column is dropped, not rejected.** `toSchemaRecord` filters against the Drizzle table's own column names, so a column that exists in the frontend schema but has not yet been migrated into Postgres uploads cleanly and disappears. This is the failure mode behind [Adding Columns to an Existing Synced Table](./powersync-account-devices.md#adding-columns-to-an-existing-synced-table): local tests pass, the value is null on every other device.

**A table with a global `id` primary key relies entirely on step 8.** Removing or weakening the `setWhere` / `WHERE user_id` clause would not break a single type, and the damage is cross-account.

## Where the code lives

| File                                                                             | Role                                                                       |
| -------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| [backend/src/dal/powersync.ts](../../backend/src/dal/powersync.ts)               | The gate: allowlists, deny lists, reserved ids, and `applyOperation`       |
| [backend/src/dal/powersync.test.ts](../../backend/src/dal/powersync.test.ts)     | Regression tests for every branch above                                    |
| [backend/src/api/powersync.ts](../../backend/src/api/powersync.ts)               | The `/token` and `/upload` routes, device validation, origin check         |
| [backend/src/db/powersync-schema.ts](../../backend/src/db/powersync-schema.ts)   | Drizzle tables plus the pk / conflict-target / column-name maps            |
| [shared/powersync-tables.ts](../../shared/powersync-tables.ts)                   | `powersyncTableNames` and `legacyPowerSyncTableNames`                      |
| [src/db/powersync/connector.ts](../../src/db/powersync/connector.ts)             | `uploadData` — builds the batch and maps error responses to client actions |
| [src/db/encryption/upload-encoder.ts](../../src/db/encryption/upload-encoder.ts) | Encrypts encrypted columns before the batch leaves the device              |
