# The Data Access Layer

Thunderbolt has two directories called `dal`, and they are not the same kind of thing.

- [`src/dal/`](../../src/dal) is the **client** DAL: seventeen modules of Drizzle queries against the
  local SQLite database that PowerSync manages. Most of its rules exist because the app's tables are
  really SQLite _views_ over PowerSync's own backing tables.
- [`backend/src/dal/`](../../backend/src/dal) is the **server** DAL: eight modules of Drizzle queries
  against PostgreSQL. It runs on real tables, so the client's constraints do not apply — but it owns
  concurrency and authorization invariants the API routes depend on.

Read this page before adding a query anywhere. Almost every rule below exists because someone hit the
failure it prevents.

## The client DAL

### Shape

Every function takes the Drizzle database as its first argument rather than reaching for a module
global. React callers get it from `useDatabase()` ([`src/contexts/database-context.tsx`](../../src/contexts/database-context.tsx));
non-React callers use `getDb()` ([`src/db/database.ts`](../../src/db/database.ts)). Passing it in is
what lets a DAL function be composed inside a transaction — the transaction client `tx` satisfies the
same `AnyDrizzleDatabase` type ([`src/db/database-interface.ts`](../../src/db/database-interface.ts)),
so `deleteModel` can call `deleteModelProfileForModel(tx, id)` and have both writes commit together.

The public surface is re-exported from [`src/dal/index.ts`](../../src/dal/index.ts); both barrel
imports (`from '@/dal'`) and deep imports (`from '@/dal/skills'`) are in use.

Business rules that a caller must be able to distinguish get typed errors rather than booleans —
`SkillNameTakenError`, `SkillNameInvalidError`, `PinLimitExceededError` in
[`src/dal/skills.ts`](../../src/dal/skills.ts) — so the UI can map each to its own message without
string-matching.

The boundary is a convention, not a lint rule — no ESLint config mentions `src/dal/`. A handful of
modules outside it build queries against the table definitions directly: the defaults reconciler, the
four client data migrations, `src/defaults/settings.ts`, `src/extensions/tasks/tools.ts` and
`src/lib/mcp-auth/ensure-valid-token.ts`. Adding to that list should be a deliberate decision, not a
shortcut around a missing DAL function.

### Reads return an un-awaited query

Read helpers deliberately do **not** `await`. They build the Drizzle query and return it, cast to
`DrizzleQueryWithPromise<T>` ([`src/types.ts:159`](../../src/types.ts)):

```ts
export const getPendingDevices = (db: AnyDrizzleDatabase) => {
  const query = db.select().from(devicesTable).where(/* … */)
  return query as typeof query & DrizzleQueryWithPromise<Device>
}
```

The cast serves two consumers at once. A one-shot caller can `await getPendingDevices(db)` and get
`Device[]` with no manual cast. A reactive caller hands the same object to
`toCompilableQuery(...)` and PowerSync re-runs it whenever the underlying tables change — see
[`src/hooks/use-pending-device-notification.ts`](../../src/hooks/use-pending-device-notification.ts)
or [`src/settings/devices.tsx`](../../src/settings/devices.tsx). Awaiting inside the DAL would
collapse the query to a plain array and silently remove live updates from every call site. If you
write a read helper that must return a scalar or a mapped object (`getModel`, `getSkill`), that is
fine — just know it is not watchable.

Write helpers are ordinary `async` functions.

### PowerSync tables are views, so `ON CONFLICT` is banned

PowerSync does not hand SQLite your tables. It keeps the rows in internal backing tables —
`ps_data__*` for synced tables, `ps_data_local__*` for local-only ones, as
[`src/search/fts-setup.ts:94`](../../src/search/fts-setup.ts) documents while reading them directly —
and exposes each schema table as a **view**. SQLite refuses UPSERT syntax on a view: the statement
fails at prepare time with `cannot UPSERT a view`, before any row is touched. This applies to both
halves of [`src/db/powersync/schema.ts`](../../src/db/powersync/schema.ts) — `syncedTables` and
`localOnlyTables` are registered in the same `DrizzleAppSchema`, and both become views.

So `onConflictDoUpdate` and `onConflictDoNothing` are unavailable in the client DAL. Two emulations
are sanctioned, and which one to pick depends on whether concurrent writers are possible.

**SELECT-then-INSERT/UPDATE** — read the row, branch, write. Correct when the write path is
single-writer. Used by `updateModel` for `models_secrets`
([`src/dal/models.ts:151`](../../src/dal/models.ts)), `setAgentSecrets`
([`src/dal/agents.ts:238`](../../src/dal/agents.ts)), `saveIntegrationCredentials`
([`src/dal/integrations.ts`](../../src/dal/integrations.ts)), and the importer
([`src/dal/import.ts:180`](../../src/dal/import.ts)).

**Insert-first, catch the conflict** — attempt the INSERT, and on a duplicate-key error fall through
to an UPDATE. This is the right choice where several callers can race, because the check-then-write
split above has a TOCTOU window. `createSetting` and `updateSettings`
([`src/dal/settings.ts:274`](../../src/dal/settings.ts), `:342`) and the message writers
([`src/dal/chat-messages.ts:104`](../../src/dal/chat-messages.ts), `:158`) use it. The catch must
narrow with `isInsertConflictError` ([`src/lib/sqlite-errors.ts`](../../src/lib/sqlite-errors.ts))
and rethrow everything else — a disk-full or corruption error must not be swallowed as "row already
exists". That helper matches on numeric errno, `SQLITE_CONSTRAINT_*` string codes, message text, and
wa-sqlite's `Unexpected step result: <code>` form, because the shape differs per backend.

**One module does not follow the rule.** `upsertModelProfile`
([`src/dal/model-profiles.ts:33`](../../src/dal/model-profiles.ts)) uses `onConflictDoUpdate` and
`createDefaultModelProfile` (`:52`) uses `onConflictDoNothing`, both against `model_profiles`, which
is registered in `syncedTables` and is therefore a view. Neither statement fires in a shipping build
today: `upsertModelProfile` has no caller outside the barrel and its test, and
`createDefaultModelProfile`'s only production caller is `createModel`
([`src/dal/models.ts:221`](../../src/dal/models.ts)), which passes a freshly generated `uuidv7()`
([`src/settings/models/use-add-model-form.ts:152`](../../src/settings/models/use-add-model-form.ts)) —
so the `defaultModelProfiles.find(...)` lookup at `model-profiles.ts:41` misses and the function
returns before reaching the insert. The statements are latent, not live. Do not treat them as
precedent, and do not route a new caller through them without converting them first.

Tests will not warn you about this. See [Testing](#testing-the-client-dal) below.

### No nested transactions

The PowerSync Drizzle driver rejects a `transaction()` opened inside another one. The consequence is
that a DAL helper which opens its own transaction cannot be reused from inside a caller's
transaction — the caller has to inline the writes instead.

Two places in the tree are shaped by this, both with the reasoning recorded inline.
`createMcpServersWithCredentials` ([`src/dal/mcp-servers.ts`](../../src/dal/mcp-servers.ts)) batches
its writes directly rather than looping over `createMcpServerWithCredentials`, which opens a
transaction per item. `advanceVersionMarker`
([`src/lib/reconcile-defaults.ts`](../../src/lib/reconcile-defaults.ts)) hand-rolls an
INSERT-or-UPDATE against `settings` instead of calling `updateSettings`, for the same reason.

The corollary for callers: **write a group of settings with one `updateSettings(db, { … })` call.**
Four separate `setValue` calls each open a transaction, and SQLite rejects a `BEGIN` while one is
open, so `Promise.all` over them fails all but the first — the reason
`src/hooks/use-language-setting.ts:33-35` awaits its two writes separately. The case that made this
concrete, seeding the four unit settings, is recorded under
["Units and their defaults"](../../AGENTS.md#units-and-their-defaults) in AGENTS.md.

### Soft delete

Per the repo-wide rule, client deletes are soft. The DAL convention is a single UPDATE that sets
`deletedAt` **and** scrubs the row's free-text columns:

```ts
await db
  .update(mcpServersTable)
  .set({ ...clearNullableColumns(mcpServersTable), deletedAt: nowIso() })
  .where(and(eq(mcpServersTable.id, id), isNull(mcpServersTable.deletedAt)))
```

`clearNullableColumns` ([`src/lib/utils.ts`](../../src/lib/utils.ts)) nulls every nullable column
while skipping primary keys, foreign keys, unique columns, `NOT NULL` columns, `userId`, and
`deletedAt` itself — so the tombstone keeps enough identity to sync and to be reasoned about, but
stops carrying the user's content to every other device. The `isNull(deletedAt)` guard in the WHERE
clause makes re-deleting a no-op, which preserves the original deletion timestamp.

Reads filter `isNull(deletedAt)`. Hard `DELETE` is for the local-only secret tables, where the point
is that the credential stops existing: `deleteMcpServer` deletes the `mcp_secrets` row and
soft-deletes the `mcp_servers` row in the same transaction. The one exception is `deleteSetting`
([`src/dal/settings.ts:372`](../../src/dal/settings.ts)), which drops a synced `settings` row outright
so the code default applies again; it has no production caller today.

### Synced config, local-only secret

Several features store a synced configuration row and keep its credential in a local-only table that
never leaves the device. The pairing and the "nothing carrying a credential may join `syncedTables`"
invariant are documented in [multi-device-sync.md](./multi-device-sync.md#local-only-tables); what
belongs here is the DAL consequence. `models` joins `models_secrets` at read time via a `LEFT JOIN`
in `selectModelsWithSecrets` ([`src/dal/models.ts`](../../src/dal/models.ts)), so a `Model` carries
its `apiKey` without the column ever being synced — and every write path has to strip `apiKey` back
out before touching `modelsTable`. `createModel` writes both halves in one transaction, so no caller
can observe a config row without its credential. The MCP DAL writes atomically for the same reason
but is not an instance of this split: `mcp_servers` is itself local-only, because replicating a
server row without its credential would hand another device a connection it cannot make — see
[mcp-connections.md](./mcp-connections.md#servers-and-secrets-are-device-local). The agent DAL has
the same split as `models` but not the same atomicity: `createAgent` writes only the synced row, and `setAgentSecrets` is
a separate call (with no production caller of its own today).

## Client database backends

`DatabaseType` has three values ([`src/db/database.ts:7`](../../src/db/database.ts)) and `Database.initialize`
branches three ways, but only one branch runs in a shipping build.

| Type         | Implementation                                                                | Where it runs                                         |
| ------------ | ----------------------------------------------------------------------------- | ----------------------------------------------------- |
| `powersync`  | [`src/db/powersync/`](../../src/db/powersync)                                 | Every platform — web, desktop, mobile                 |
| `bun-sqlite` | [`src/db/bun-sqlite-database.ts`](../../src/db/bun-sqlite-database.ts)        | Tests only, via `src/dal/test-utils.ts`               |
| `wa-sqlite`  | [`src/db/wa-sqlite-database.ts`](../../src/db/wa-sqlite-database.ts) + worker | Nowhere — unreachable in every shipping configuration |

`getDatabaseType()` ([`src/lib/platform.ts:272`](../../src/lib/platform.ts)) has a JSDoc promising
platform- and capability-based selection, and is `async` for a backend query that JSDoc anticipates;
the body is `return 'powersync'`. Its only callers are `src/hooks/use-app-initialization.ts` and
`src/lib/fs.ts`, so the `wa-sqlite` branch in `database.ts` is dead. The three WA-SQLite source
files and their tests still build and still pull in `@journeyapps/wa-sqlite` as a direct dependency.
They should either be deleted or have their revival condition written down — right now a reader
cannot tell which.

Note that `wa-sqlite` still appears in two live code paths for reasons unrelated to the backend
selector: `src/lib/fs.ts` treats it like `powersync` when resolving the OPFS database path, and
`isInsertConflictError` recognizes the wa-sqlite worker's error format.

## Testing the client DAL

Tests run on `bun-sqlite` through `setupTestDatabase` / `resetTestDatabase`
([`src/dal/test-utils.ts`](../../src/dal/test-utils.ts)). The schema is not built from migrations —
`applySchema` ([`src/db/apply-schema.ts`](../../src/db/apply-schema.ts)) generates `CREATE TABLE`
statements from the Drizzle definitions at init, mirroring how PowerSync applies its schema.

Two divergences from the app are worth holding in mind.

**Views versus tables.** `bun-sqlite` creates real tables, so `ON CONFLICT` works there. A DAL
function that violates the views rule passes its unit tests and fails only in the app — which is
exactly the situation `src/dal/model-profiles.test.ts:318` is in, asserting
`onConflictDoNothing` behavior that the PowerSync backend would reject at prepare time.

**Indexes.** The same partial index exists in three different shapes. `src/db/tables.ts` declares a
dozen of them as `WHERE deleted_at IS NULL`. The PowerSync Drizzle driver keeps only the column list
and drops the predicate (`toPowerSyncTable` in `@powersync/drizzle-driver`), so the app gets a full
index. `applySchema` skips partial indexes outright
([`src/db/apply-schema.ts:52-53`](../../src/db/apply-schema.ts)), so tests get no index at all.
Nothing about correctness changes, but never conclude anything about index usage from a test.

## The backend DAL

The server DAL talks to PostgreSQL, so the client's central constraint is inverted: these are real
tables, `ON CONFLICT` is the idiom, and it is load-bearing. Every upsert pins its conflict handling
with a `setWhere` clause re-asserting ownership (`eq(devicesTable.userId, …)`) or liveness
(`isNull(devicesTable.revokedAt)`): `upsertDevice`, `upsertCliDevice`, `registerDevice` and
`registerBridgeDevice` in [`devices.ts`](../../backend/src/dal/devices.ts), plus `upsertEnvelope` in
[`encryption.ts`](../../backend/src/dal/encryption.ts). An upsert that lands on someone else's row,
or on a revoked row, therefore updates nothing — and the four device upserts end in `.returning()`
so the caller reads the empty result as the refusal. `applyOperation` does the same for client
uploads, building the conflict target from the schema
([`backend/src/dal/powersync.ts:143-152`](../../backend/src/dal/powersync.ts)).

### Two database types, and why the distinction matters

`QueryableDatabase` ([`backend/src/db/client.ts:88`](../../backend/src/db/client.ts)) is
`Pick<typeof db, 'delete' | 'insert' | 'select' | 'update'>` — the query-builder surface shared by
the root connection and a transaction client. A helper typed against it can be called with `tx`
inside `database.transaction(...)`; a helper typed `typeof db` cannot. That is the whole reason most
of the device, session, and encryption helpers take `QueryableDatabase` while the waitlist, user, OTP
and PowerSync-upload helpers take `typeof db`: the former are composed into multi-statement
transactions in `backend/src/api/account.ts` and `backend/src/api/encryption.ts`, the latter never
are. The split is per helper, not per module — `denyDevice`, `setDeviceNodeId` and
`getTrustedNodeIds` live in `devices.ts` and still take `typeof db`, because nothing transacts them.
Widen a signature to `QueryableDatabase` when you first need to transact it, rather than passing the
root connection into a transaction and losing atomicity without a type error.

### Module map

| Module                                                               | Owns                                                                                                           |
| -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| [`devices.ts`](../../backend/src/dal/devices.ts)                     | Device identity, trust, revocation, the per-account registration lock, and the reserved id namespaces (below)  |
| [`sessions.ts`](../../backend/src/dal/sessions.ts)                   | Binding a Better Auth session to a device, and revoking every session for a device                             |
| [`encryption.ts`](../../backend/src/dal/encryption.ts)               | Envelopes (wrapped Content Keys) and the canary metadata row — see [e2e-encryption.md](./e2e-encryption.md)    |
| [`powersync.ts`](../../backend/src/dal/powersync.ts)                 | Applying one client upload op — see [powersync-upload-authorization.md](./powersync-upload-authorization.md)   |
| [`otp-challenge.ts`](../../backend/src/dal/otp-challenge.ts)         | The sign-in challenge token's first-writer-wins lifecycle, plus deleting Better Auth's persisted OTP           |
| [`users.ts`](../../backend/src/dal/users.ts)                         | User lookup, the `isNew` flag, and the hard delete that cascades account deletion                              |
| [`waitlist.ts`](../../backend/src/dal/waitlist.ts)                   | Waitlist entry create (conflict-tolerant) and approval                                                         |
| [`debug-transcripts.ts`](../../backend/src/dal/debug-transcripts.ts) | Transcript intake rows and intake-client key-hash lookup (returns revoked clients so the route can answer 403) |

### Invariants worth knowing before you touch a device route

**Registration is serialized per account.** `withUserDeviceRegistrationLock`
([`backend/src/dal/devices.ts:20`](../../backend/src/dal/devices.ts)) takes a Postgres transaction
advisory lock keyed on `hashtext(userId)` and runs the operation inside it. It exists because the
device cap (`maxActiveDevicesPerUser = 10`, `devices.ts:17`) is a count-then-insert, and two
concurrent registrations would both read nine and both insert. The lock is `pg_advisory_xact_lock`,
so it releases with the transaction — which means it is only meaningful when you pass it `tx`, not
the root connection. The revoke route is the worked example: `backend/src/api/account.ts:296-305`
wraps `deleteEnvelope`, `revokeDevice`, and `revokeDeviceSessions` in one locked transaction, the
session purge conditional on `revokeDevice` having matched a row. Why the envelope is deleted at all,
and why the cap is enforced twice, is in [e2e-encryption.md](./e2e-encryption.md) and
[delete-account-and-revoke-device.md](./delete-account-and-revoke-device.md).

**Two device-id prefixes are reserved.** `bridge-` (`bridgeDeviceIdPrefix`) and `cli-`
(`cliDeviceIdPrefix`, from [`shared/cli-device-id.ts`](../../shared/cli-device-id.ts)) name rows
that only their server routes may create. `isReservedDeviceId` in `backend/src/dal/powersync.ts` rejects any client upload op whose
`devices` id starts with either, so a client cannot forge or overwrite a bridge or CLI row through
the sync path (the rest of that gate is in
[powersync-upload-authorization.md](./powersync-upload-authorization.md)). A bridge's id is additionally _derived_ —
`bridgeDeviceId(userId, nodeId) = 'bridge-' + sha256(userId + ':' + nodeId)` — which makes
re-registering the same bridge an idempotent upsert on `(userId, nodeId)` without a dedicated unique
constraint, and makes cross-account id collision impossible.

**`isTrustedAppDevice` is the authorization predicate, not a field read.** It requires the row to
exist, to belong to the calling user, to not be a `cli` device, and to be `trusted` —
`devices.ts:30-33`. CLI devices are excluded because they are server-owned: `upsertCliDevice` pins
`publicKey` and `mlkemPublicKey` to `null` (`devices.ts:103-104`), so no envelope can ever be wrapped
to one and it must never act as the approving party in a trust decision. Routes that gate on "a real
trusted device of this account is asking" call it rather than checking `device.trusted` — three
encryption routes unconditionally (`backend/src/api/encryption.ts:264`, `:417`, `:471`), and
`POST /v1/account/devices/:id/revoke` for accounts that have encryption metadata, where it is layered
with `device_type = 'normal'` and non-revoked (`backend/src/api/account.ts:284-293`). Four query
helpers encode the same CLI exclusion in SQL instead: `markDeviceTrusted`, `denyDevice` and
`setDeviceNodeId` carry `ne(devicesTable.deviceType, 'cli')` in their UPDATE, `getTrustedNodeIds` in
its SELECT.

**Guards live in the WHERE clause, and callers check `.returning()`.** `markDeviceTrusted` requires
`approval_pending = true` and `revoked_at IS NULL`; `denyDevice` requires `trusted = false`;
`setDeviceNodeId` excludes both revoked and denied rows; `deleteRevokedBridgeDevice` re-checks
device type and revocation in the DELETE. Each returns its updated rows so the caller can detect the
zero-row case, which is how the deny-versus-approve and revoke-versus-approve races resolve without
a second read. Moving one of those predicates up into an `if` in the route reintroduces the TOCTOU
window it was written to close.

**Session binding is device-scoped.** `linkSessionToDevice` only binds a session whose `device_id` is
null or already the same device, so a session cannot be stolen by a second device. The CLI
device-grant flow needs one extra transition — a session created by the grant carries the marker
`cliRegistrationPendingDeviceId = 'cli-registration-pending'`
([`backend/src/dal/sessions.ts:12`](../../backend/src/dal/sessions.ts)) until registration binds a
real device id — so `linkCliSessionToDevice` is a separate entry point rather than a flag on the
common one.

## Related pages

- [Multi-Device Sync](./multi-device-sync.md) — synced versus local-only tables, offline behavior.
- [PowerSync, Account & Device Management](./powersync-account-devices.md) — adding, removing and
  deploying a synced table; the device registration and revocation flows end to end.
- [Composite Primary Keys and Default Data](./composite-primary-keys-and-default-data.md) — why some
  synced tables key on `(id, user_id)`.
- [Delete Account and Revoke Device](./delete-account-and-revoke-device.md) — the upload deny-lists
  and what a revoked device sees.
- [Client Data Migrations](./client-data-migrations.md) — writing a migration that converges across
  devices.
- [Export Format](./export-format.md) — the exporter and importer, which are DAL modules with their
  own compatibility contract.
- [Reconciled Defaults](./reconciled-defaults.md) — the one caller that writes into user tables on
  every boot, and the hash/version signals it uses;
  [AGENTS.md](../../AGENTS.md#reconciled-defaults-and-version-bumps) has the short version.
