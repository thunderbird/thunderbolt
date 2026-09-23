# The Data Access Layer

Thunderbolt has two directories called `dal`, and they are not the same kind of thing.

| Directory                                   | Kind       | Contents                                                       | Defining constraint                                                                          |
| ------------------------------------------- | ---------- | -------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| [`src/dal/`](../../src/dal)                 | **client** | 17 modules of Drizzle queries against PowerSync's local SQLite | The app's tables are really SQLite _views_ over PowerSync's backing tables                   |
| [`backend/src/dal/`](../../backend/src/dal) | **server** | 8 modules of Drizzle queries against PostgreSQL                | Real tables, so the client's rules do not apply, but it owns the API's concurrency and authz |

## Client DAL rules

| Rule                                                    | Why                                                      |
| ------------------------------------------------------- | -------------------------------------------------------- |
| The database is always the first argument               | Lets a helper compose inside a caller's transaction      |
| Read helpers return an un-awaited query                 | Awaiting collapses it to an array and kills live updates |
| No `onConflictDoUpdate` / `onConflictDoNothing`         | SQLite refuses UPSERT on a view                          |
| No nested `transaction()`                               | The PowerSync Drizzle driver rejects them                |
| Deletes are soft, and scrub the row's free-text columns | The tombstone must sync without carrying user content    |

### Shape

- The Drizzle database is the first argument, never a module global. React callers use
  `useDatabase()` ([`database-context.tsx`](../../src/contexts/database-context.tsx)), others
  `getDb()` ([`src/db/database.ts`](../../src/db/database.ts)). A transaction client `tx` satisfies
  the same `AnyDrizzleDatabase` ([`database-interface.ts`](../../src/db/database-interface.ts)), so
  `deleteModel` can call `deleteModelProfileForModel(tx, id)` in one commit.
- The public surface is re-exported from [`src/dal/index.ts`](../../src/dal/index.ts); barrel
  (`from '@/dal'`) and deep (`from '@/dal/skills'`) imports are both in use.
- Business rules a caller must distinguish get typed errors, not booleans: `SkillNameTakenError`,
  `SkillNameInvalidError`, `PinLimitExceededError`
  ([`src/dal/skills.ts`](../../src/dal/skills.ts)).
- The boundary is a convention; no ESLint config mentions `src/dal/`. These query the table
  definitions directly: the defaults reconciler, the four client data migrations,
  `src/defaults/settings.ts`, `src/extensions/tasks/tools.ts`,
  `src/lib/mcp-auth/ensure-valid-token.ts`. Additions are deliberate.

### Reads return an un-awaited query

Read helpers build the query and return it, cast to `DrizzleQueryWithPromise<T>`
([`src/types.ts:159`](../../src/types.ts)):

```ts
export const getPendingDevices = (db: AnyDrizzleDatabase) => {
  const query = db.select().from(devicesTable).where(/* … */)
  return query as typeof query & DrizzleQueryWithPromise<Device>
}
```

One-shot callers `await` it and get `Device[]`. Reactive callers pass the same object to
`toCompilableQuery(...)`, and PowerSync re-runs it whenever the tables change
([`use-pending-device-notification.ts`](../../src/hooks/use-pending-device-notification.ts),
[`settings/devices.tsx`](../../src/settings/devices.tsx)). Helpers returning a scalar or mapped object
(`getModel`, `getSkill`) are fine but not watchable; write helpers are ordinary `async`.

### PowerSync tables are views, so `ON CONFLICT` is banned

SQLite fails UPSERT on a view at prepare time with `cannot UPSERT a view`. PowerSync keeps rows in
backing tables (`ps_data__*` synced, `ps_data_local__*` local-only,
read directly at [`src/search/fts-setup.ts:94`](../../src/search/fts-setup.ts)) and exposes each
schema table as a view. Both `syncedTables` and `localOnlyTables`
([`src/db/powersync/schema.ts`](../../src/db/powersync/schema.ts)) register in the same
`DrizzleAppSchema`.

Two emulations are sanctioned:

| Emulation                                                  | Correct when                                       | Call sites                                                                                                                                                                                                                                                                                                                    |
| ---------------------------------------------------------- | -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **SELECT-then-INSERT/UPDATE**: read the row, branch, write | The write path is single-writer                    | `updateModel` for `models_secrets` ([`src/dal/models.ts:151`](../../src/dal/models.ts)), `setAgentSecrets` ([`src/dal/agents.ts:238`](../../src/dal/agents.ts)), `saveIntegrationCredentials` ([`src/dal/integrations.ts`](../../src/dal/integrations.ts)), the importer ([`src/dal/import.ts:180`](../../src/dal/import.ts)) |
| **Insert-first, catch the conflict**, then UPDATE          | Callers can race, so check-then-write has a TOCTOU | `createSetting` and `updateSettings` ([`src/dal/settings.ts:274`](../../src/dal/settings.ts), `:342`), the message writers ([`src/dal/chat-messages.ts:104`](../../src/dal/chat-messages.ts), `:158`)                                                                                                                         |

Narrow the catch with `isInsertConflictError`
([`src/lib/sqlite-errors.ts`](../../src/lib/sqlite-errors.ts)) and rethrow the rest, so a disk-full
or corruption is not swallowed as "row already exists". It matches numeric errno,
`SQLITE_CONSTRAINT_*` codes, message text and wa-sqlite's `Unexpected step result: <code>`; the
shape is backend-specific.

**One module breaks the rule, latently.** In
[`src/dal/model-profiles.ts`](../../src/dal/model-profiles.ts), `upsertModelProfile` (`:33`) uses
`onConflictDoUpdate` and `createDefaultModelProfile` (`:52`) uses `onConflictDoNothing`, both against
`model_profiles`, a synced table and therefore a view. Neither fires in a shipping build:
`upsertModelProfile` has no caller outside the barrel and its test, and `createDefaultModelProfile`'s
only production caller `createModel` ([`models.ts:221`](../../src/dal/models.ts)) passes a fresh
`uuidv7()` ([`use-add-model-form.ts:152`](../../src/settings/models/use-add-model-form.ts)), so the
`defaultModelProfiles.find(...)` at `model-profiles.ts:41` misses and it returns before the insert. Not precedent:
convert them before routing a new caller through them, and note that tests will not warn you
([Testing](#testing-the-client-dal)).

### No nested transactions

A helper that opens its own transaction cannot be reused inside one. Two places inline their writes
instead, with the reasoning in the code:

- `createMcpServersWithCredentials` ([`src/dal/mcp-servers.ts`](../../src/dal/mcp-servers.ts))
  batches directly rather than looping over `createMcpServerWithCredentials`, which opens one
  transaction per item.
- `advanceVersionMarker` ([`src/lib/reconcile-defaults.ts`](../../src/lib/reconcile-defaults.ts))
  hand-rolls an INSERT-or-UPDATE against `settings` rather than calling `updateSettings`.

Corollary: **write a group of settings with one `updateSettings(db, { … })` call.** Separate
`setValue` calls each open a transaction, and SQLite rejects a `BEGIN` while one is open, so
`Promise.all` over them fails all but the first; `src/hooks/use-language-setting.ts:33-35` awaits
its two writes separately. Background:
["Units and their defaults"](../../AGENTS.md#units-and-their-defaults).

### Soft delete

One UPDATE sets `deletedAt` **and** scrubs the row's free-text columns.

```ts
await db
  .update(mcpServersTable)
  .set({ ...clearNullableColumns(mcpServersTable), deletedAt: nowIso() })
  .where(and(eq(mcpServersTable.id, id), isNull(mcpServersTable.deletedAt)))
```

- `clearNullableColumns` ([`src/lib/utils.ts`](../../src/lib/utils.ts)) nulls every nullable column,
  skipping primary keys, foreign keys, unique columns, `NOT NULL` columns, `userId` and `deletedAt`,
  so the tombstone keeps enough identity to sync without carrying user content to other devices.
- The `isNull(deletedAt)` guard makes re-deleting a no-op, preserving the original timestamp; reads
  filter on it too.
- Hard `DELETE` is for local-only secret tables, where the point is that the credential stops
  existing: `deleteMcpServer` deletes the `mcp_secrets` row and
  soft-deletes the `mcp_servers` row in one transaction.
- Exception: `deleteSetting` ([`src/dal/settings.ts:372`](../../src/dal/settings.ts)) drops a synced
  `settings` row outright so the code default applies again (no production caller today).

### Synced config, local-only secret

Several features pair a synced config row with a credential in a local-only table; the "nothing
carrying a credential may join `syncedTables`" invariant is in
[multi-device-sync.md](./multi-device-sync.md#local-only-tables). DAL consequences:

- **Models.** `selectModelsWithSecrets` ([`src/dal/models.ts`](../../src/dal/models.ts)) `LEFT JOIN`s
  `models_secrets` at read time, so a `Model` carries `apiKey` without the column syncing, and every
  write path strips `apiKey` before touching `modelsTable`. `createModel` writes both halves in one
  transaction, so no caller observes a config row without its credential.
- **Agents.** Same split without the atomicity: `createAgent` writes only the synced row, and
  `setAgentSecrets` is separate (no production caller today).
- **MCP.** Not this split: `mcp_servers` is itself local-only, because replicating a server row
  without its credential hands another device a connection it cannot make
  ([mcp-connections.md](./mcp-connections.md#servers-and-secrets-are-device-local)).

## Client database backends

`DatabaseType` has three values ([`src/db/database.ts:7`](../../src/db/database.ts)) and
`Database.initialize` branches three ways, but only one branch ships.

| Type         | Implementation                                                                | Where it runs                            |
| ------------ | ----------------------------------------------------------------------------- | ---------------------------------------- |
| `powersync`  | [`src/db/powersync/`](../../src/db/powersync)                                 | Every platform: web, desktop, mobile     |
| `bun-sqlite` | [`src/db/bun-sqlite-database.ts`](../../src/db/bun-sqlite-database.ts)        | Tests only, via `src/dal/test-utils.ts`  |
| `wa-sqlite`  | [`src/db/wa-sqlite-database.ts`](../../src/db/wa-sqlite-database.ts) + worker | Nowhere; unreachable in shipping configs |

`getDatabaseType()` ([`src/lib/platform.ts:272`](../../src/lib/platform.ts)) promises platform- and
capability-based selection in its JSDoc and is `async` for a backend query that JSDoc anticipates;
the body is `return 'powersync'`. Its only callers are `src/hooks/use-app-initialization.ts` and `src/lib/fs.ts`, so the `wa-sqlite` branch
is dead, yet its three source files and their tests still build and still pull in
`@journeyapps/wa-sqlite` as a direct dependency. Delete them or write down their revival
condition.

`wa-sqlite` survives in two paths unrelated to the selector: `src/lib/fs.ts` treats it like
`powersync` when resolving the OPFS database path, and `isInsertConflictError` recognizes the
wa-sqlite worker's error format.

## Testing the client DAL

Tests run on `bun-sqlite` through `setupTestDatabase` / `resetTestDatabase`
([`src/dal/test-utils.ts`](../../src/dal/test-utils.ts)). The schema comes from `applySchema`
([`src/db/apply-schema.ts`](../../src/db/apply-schema.ts)), which generates `CREATE TABLE` from the
Drizzle definitions at init, not from migrations, mirroring how PowerSync applies its schema. Two
divergences matter.

**Views versus tables.** `bun-sqlite` creates real tables, so `ON CONFLICT` works there: a DAL
function violating the views rule passes its unit tests and fails only in the app, as
`src/dal/model-profiles.test.ts:318` does, asserting `onConflictDoNothing` behavior PowerSync would
reject at prepare time.

**Indexes.** The same partial index exists in three shapes: `src/db/tables.ts` declares a dozen as
`WHERE deleted_at IS NULL`; the PowerSync Drizzle driver keeps the column list and drops the
predicate (`toPowerSyncTable` in `@powersync/drizzle-driver`), giving the app a full index;
`applySchema` skips partial indexes ([`apply-schema.ts:52-53`](../../src/db/apply-schema.ts)),
giving tests none.
Correctness is unaffected, but never conclude anything about index usage from a test.

## The backend DAL

| Module                                                               | Owns                                                                                                          |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| [`devices.ts`](../../backend/src/dal/devices.ts)                     | Device identity, trust, revocation, the per-account registration lock, and the reserved id namespaces (below) |
| [`sessions.ts`](../../backend/src/dal/sessions.ts)                   | Binding a Better Auth session to a device, and revoking every session for a device                            |
| [`encryption.ts`](../../backend/src/dal/encryption.ts)               | Envelopes (wrapped Content Keys) and the canary metadata row; see [e2e-encryption.md](./e2e-encryption.md)    |
| [`powersync.ts`](../../backend/src/dal/powersync.ts)                 | Applying one client upload op; see [powersync-upload-authorization.md](./powersync-upload-authorization.md)   |
| [`otp-challenge.ts`](../../backend/src/dal/otp-challenge.ts)         | The sign-in challenge token's first-writer-wins lifecycle, plus deleting Better Auth's persisted OTP          |
| [`users.ts`](../../backend/src/dal/users.ts)                         | User lookup, the `isNew` flag, and the hard delete that cascades account deletion                             |
| [`waitlist.ts`](../../backend/src/dal/waitlist.ts)                   | Waitlist entry create (conflict-tolerant) and approval                                                        |
| [`debug-transcripts.ts`](../../backend/src/dal/debug-transcripts.ts) | Transcript intake rows and intake-client key-hash lookup (returns revoked clients so the route can 403)       |

### `ON CONFLICT` is the idiom, and `setWhere` is load-bearing

Every upsert pins its conflict handling with a `setWhere` re-asserting ownership
(`eq(devicesTable.userId, …)`) or liveness (`isNull(devicesTable.revokedAt)`): `upsertDevice`,
`upsertCliDevice`, `registerDevice`, `registerBridgeDevice`
([`devices.ts`](../../backend/src/dal/devices.ts)) and `upsertEnvelope`
([`encryption.ts`](../../backend/src/dal/encryption.ts)).

An upsert landing on someone else's row, or a revoked row, updates nothing; the four device upserts
end in `.returning()` so the caller reads the empty result as the refusal. `applyOperation` does the
same for uploads, building the conflict target from the schema
([`powersync.ts:143-152`](../../backend/src/dal/powersync.ts)).

### Which database type a helper takes

`QueryableDatabase` ([`backend/src/db/client.ts:88`](../../backend/src/db/client.ts)) is
`Pick<typeof db, 'delete' | 'insert' | 'select' | 'update'>`, the surface shared by the root
connection and a transaction client. A helper typed against it takes `tx` inside
`database.transaction(...)`; one typed `typeof db` cannot.

- `QueryableDatabase`: most device, session and encryption helpers, composed into multi-statement
  transactions by `backend/src/api/account.ts` and `backend/src/api/encryption.ts`.
- `typeof db`: waitlist, user, OTP and PowerSync-upload helpers, plus `denyDevice`, `setDeviceNodeId`
  and `getTrustedNodeIds` in `devices.ts`, which nothing transacts. The split is per helper, not per
  module.

Widen a signature when you first need to transact it, rather than passing the root connection into a
transaction and losing atomicity without a type error.

### Invariants worth knowing before you touch a device route

**Registration is serialized per account.** `withUserDeviceRegistrationLock`
([`devices.ts:20`](../../backend/src/dal/devices.ts)) takes a Postgres advisory lock on
`hashtext(userId)`: the device cap (`maxActiveDevicesPerUser = 10`, `devices.ts:17`) is a
count-then-insert, so two concurrent registrations would both read nine and both insert. It is
`pg_advisory_xact_lock`, so it releases with the transaction and only does anything when you pass it
`tx`, not the root connection.
`backend/src/api/account.ts:296-305` wraps `deleteEnvelope`, `revokeDevice` and
`revokeDeviceSessions` in one locked transaction, the session purge conditional on `revokeDevice`
matching a row. Why the envelope is deleted and why the cap is enforced twice:
[e2e-encryption.md](./e2e-encryption.md),
[delete-account-and-revoke-device.md](./delete-account-and-revoke-device.md).

**Two device-id prefixes are reserved.** `bridge-` (`bridgeDeviceIdPrefix`) and `cli-`
(`cliDeviceIdPrefix`, [`shared/cli-device-id.ts`](../../shared/cli-device-id.ts)) name rows only
their server routes may create. `isReservedDeviceId` (`backend/src/dal/powersync.ts`) rejects any
upload op whose `devices` id starts with either, so a client cannot forge or overwrite a bridge or CLI row through the sync path
([powersync-upload-authorization.md](./powersync-upload-authorization.md) has the rest of the gate).
A bridge id is also _derived_, `bridgeDeviceId(userId, nodeId) = 'bridge-' + sha256(userId + ':' + nodeId)`, making
re-registration an idempotent upsert on `(userId, nodeId)` without a unique constraint and
cross-account collision impossible.

**`isTrustedAppDevice` is the authorization predicate, not a field read.** The row must exist,
belong to the calling user, not be a `cli` device, and be `trusted` (`devices.ts:30-33`). CLI devices
are server-owned: `upsertCliDevice` pins `publicKey` and `mlkemPublicKey` to `null`
(`devices.ts:103-104`), so no envelope can be wrapped to one and it must never be the approving party
in a trust decision.

- Callers use it instead of reading `device.trusted`: three encryption routes unconditionally
  ([`api/encryption.ts:264`](../../backend/src/api/encryption.ts), `:417`, `:471`), and
  `POST /v1/account/devices/:id/revoke` for accounts with encryption metadata, layered with
  `device_type = 'normal'` and non-revoked (`api/account.ts:284-293`).
- Four helpers encode the exclusion in SQL: `ne(devicesTable.deviceType, 'cli')` in the
  `markDeviceTrusted`, `denyDevice` and `setDeviceNodeId` UPDATEs, and in the `getTrustedNodeIds`
  SELECT.

**Guards live in the WHERE clause, and callers check `.returning()`.**

| Helper                      | Guard                                               |
| --------------------------- | --------------------------------------------------- |
| `markDeviceTrusted`         | `approval_pending = true`, `revoked_at IS NULL`     |
| `denyDevice`                | `trusted = false`                                   |
| `setDeviceNodeId`           | excludes revoked and denied rows                    |
| `deleteRevokedBridgeDevice` | re-checks device type and revocation, in the DELETE |

Each returns its updated rows so the caller can detect the zero-row case, which is how the
deny-versus-approve and revoke-versus-approve races
resolve without a second read. Moving a predicate into an `if` in the route reopens the TOCTOU window
it closes.

**Session binding is device-scoped.** `linkSessionToDevice` binds only a session whose `device_id`
is null or already the same device, so a second device cannot steal it. `linkCliSessionToDevice` is
separate because the CLI device-grant flow needs one extra transition: its session carries
`cliRegistrationPendingDeviceId = 'cli-registration-pending'`
([`sessions.ts:12`](../../backend/src/dal/sessions.ts)) until registration binds a real device id.

## Related pages

- [Multi-Device Sync](./multi-device-sync.md): synced versus local-only tables, offline behavior.
- [PowerSync, Account & Device Management](./powersync-account-devices.md): adding, removing and
  deploying a synced table; registration and revocation end to end.
- [Composite Primary Keys and Default Data](./composite-primary-keys-and-default-data.md): why some
  synced tables key on `(id, user_id)`.
- [Delete Account and Revoke Device](./delete-account-and-revoke-device.md): upload deny-lists, and
  what a revoked device sees.
- [Client Data Migrations](./client-data-migrations.md): migrations that converge across devices.
- [Export Format](./export-format.md): the exporter and importer, DAL modules with their own
  compatibility contract.
- [Reconciled Defaults](./reconciled-defaults.md): the one caller that writes into user tables on
  every boot, and the hash/version signals it uses. Short version in
  [AGENTS.md](../../AGENTS.md#reconciled-defaults-and-version-bumps).
