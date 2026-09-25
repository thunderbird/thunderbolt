# Composite Primary Keys and Default Data

Tables holding seeded default data use composite primary keys `(id, user_id)` or `(key, user_id)`, so every account can own a row under the same default ID. Defaults ship with fixed IDs: a UUIDv7 for row-shaped defaults (`shared/defaults/models.ts`, `src/defaults/tasks.ts`, `src/defaults/skills.ts`) or a fixed key for settings (`language`, `time_format`, …).

## Tables with Composite Primary Keys

| Table          | Composite key    | Reason                                                                                                                                                                                       |
| -------------- | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| settings       | `(key, user_id)` | Keys like `language` or `time_format` are shared; each user has their own value.                                                                                                             |
| models         | `(id, user_id)`  | Defaults seeded per user under the same ID (`shared/defaults/models.ts`).                                                                                                                    |
| tasks          | `(id, user_id)`  | Defaults seeded per user under the same ID (`src/defaults/tasks.ts`).                                                                                                                        |
| skills         | `(id, user_id)`  | Defaults seeded per user under the same ID (`src/defaults/skills.ts`).                                                                                                                       |
| model_profiles | `(id, user_id)`  | Per-model inference tuning (temperature, nudges, prompt overrides) seeded per user.                                                                                                          |
| prompts        | `(id, user_id)`  | Historical: default automations were seeded here until skills superseded them in THU-547, and `reconcileDefaults()` no longer touches `prompts`. The key stays for rows written before that. |
| agents         | `(id, user_id)`  | Nothing is seeded (user-created ACP agents, no `default_hash` column). The key follows the convention of the tables around it.                                                               |

In `settings` the key column is physically named `id` "for PowerSync compatibility" and is only accessed as `key` in Drizzle (`backend/src/db/powersync-schema.ts:32`, `src/db/tables.ts:13`). The `(key, user_id)` notation used here follows the Drizzle keys; the constraint on disk is on `(id, user_id)`.

## Tables with Single Primary Key

User-created data keeps a single `id` primary key, since each row already has a globally unique ID: chat_threads, chat_messages, triggers, devices, projects.

Local-only client tables never reach this schema at all: `mcp_servers`, `mcp_secrets`, `models_secrets`, `integrations_secrets`, `agents_system` and `agents_secrets` are declared in `localOnlyTables` (`src/db/powersync/schema.ts`) and have no backend counterpart.

The authoritative lists are `powersyncTableNames` (`shared/powersync-tables.ts`) and the `powersyncPkColumn` / `powersyncConflictTarget` maps (`backend/src/db/powersync-schema.ts`). Both maps are typed as `Record<PowerSyncTableName, …>`, so a table missing from either is a compile error. A table dropped from the synced schema moves to `legacyPowerSyncTableNames` (`modes`, `project_files`) rather than disappearing; see [Removing a Synced Table](powersync-account-devices.md#removing-a-synced-table) for why that entry can never be taken back off the list.

## How It Works

### Frontend (SQLite)

The local SQLite schema uses a single-column primary key, because the local database holds one user's data. `reconcileDefaults()` (`src/lib/reconcile-defaults.ts`) seeds defaults at initialization, on first run and when a new device connects via PowerSync. Overwriting an existing row clears two gates, not one:

- `default_hash` holds the hash of the row as reconcile last wrote it. Re-hashing the stored row and getting something else means the user edited it, and the row is left alone.
- The bundle's `defaults<X>Version` must be strictly newer than the highest version ever applied to this account, recorded under the `defaults_version.*` settings keys (`versionMarkerKeys`, `src/lib/reconcile-defaults.ts`). On a table that already has rows, PowerSync's initial sync must also have completed: until it has, a missing marker cannot be told apart from one that simply has not arrived, and an older-bundle device would downgrade newer synced rows. A fresh install with no rows bypasses that and seeds offline (`computeCanOverwrite`).

Changing a default without bumping its version constant therefore changes nothing on an existing account. See "Reconciled defaults and version bumps" in `AGENTS.md` for the per-table constants.

### Backend (Postgres, PowerSync)

Multiple users hold rows with the same default ID (two accounts both have the bundled Opus 5 model row, under one UUIDv7), so the backend schema uses composite primary keys for those tables. `powersyncConflictTarget` (`backend/src/db/powersync-schema.ts`) defines each table's conflict target, including both columns for composite-PK tables so `INSERT ... ON CONFLICT` upserts per user.

### PowerSync Upload

The backend scopes every uploaded PUT operation by `user_id` from the JWT:

- **INSERT**: `user_id` comes from the session; composite-PK tables use `ON CONFLICT (id, user_id)` or `ON CONFLICT (key, user_id)`.
- **PATCH/DELETE**: the `WHERE` clause includes both the row identifier (`id` or `key`) and `user_id`, so each user can only affect their own rows.

## Adding New Default-Data Tables

1. Use a composite primary key `(id, user_id)`, or `(key, user_id)` for settings-like tables, in the backend PowerSync schema.
2. Add `default_hash` if the table should track user modifications and support reconciling default updates.
3. Update `powersyncConflictTarget` (`backend/src/db/powersync-schema.ts`) to include both columns.
4. Update `powersyncPkColumn` if needed: the primary key column used for PATCH/DELETE `WHERE` clauses, the "business" id rather than user_id.

---

## Foreign Keys and Indexes

### Why We Don't Use Composite Foreign Keys

References to composite-PK tables are plain columns, not constraints. `chatMessagesTable.modelId` is declared `modelId: text('model_id')` with no `.references()` or `foreignKey()`, even though `modelsTable` has PK `(id, user_id)`.

1. **PowerSync architecture**: the backend is a sync server, not a query engine; most queries and joins happen in the frontend SQLite.
2. **E2E encryption**: the backend cannot meaningfully query or enforce relationships across encrypted data.
3. **Performance**: FK checks add overhead to every sync INSERT/UPDATE for minimal value.
4. **Flexibility**: client data still syncs while relationships are temporarily inconsistent (partial syncs).

### Index Strategy: user_id Only

The backend schema carries primary keys plus a single `user_id` index per table, and nothing else: no active indexes (`WHERE deletedAt IS NULL`) and no foreign key indexes (`chatThreadId`, `promptId`).

PowerSync sync rules always filter by `user_id` to decide what to sync to each device, which is what makes that one index essential. Everything else stays off: complex queries run against local SQLite, each index costs storage and slows sync writes, and encrypted columns cannot be filtered or searched anyway.

### When Adding New Tables

For any new PowerSync-synced table:

1. ✅ **Do** add a `user_id` column with an index: `index('idx_[table]_user_id').on(table.userId)`
2. ✅ **Do** use composite primary keys for default-data tables (see above)
3. ❌ **Don't** add composite foreign key constraints
4. ❌ **Don't** add active indexes or other query-optimization indexes
5. ❌ **Don't** add indexes on foreign key columns

Those are the schema rules only. The rest of the procedure (client schema, the three sync-rule configs, the two-PR deploy order) is in [Adding a New Synced Table](powersync-account-devices.md#adding-a-new-synced-table).
