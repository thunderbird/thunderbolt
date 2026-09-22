# Composite Primary Keys and Default Data

This document describes why certain tables use composite primary keys `(id, user_id)` or `(key, user_id)` and how this design supports default data that is seeded at initialization.

## Overview

Several tables hold data that is **seeded as defaults** when a user first initializes the app (or when a new device connects via PowerSync). Each default ships with a fixed ID that is the same in every account — a UUIDv7 for row-shaped defaults (`shared/defaults/models.ts`, `src/defaults/tasks.ts`, `src/defaults/skills.ts`) or a fixed key for settings (`language`, `time_format`, …). To allow each user to have their own row under the same default ID, these tables use **composite primary keys** that include `user_id`.

## Tables with Composite Primary Keys

| Table          | Composite key    | Reason                                                                                                                                                                                                 |
| -------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| settings       | `(key, user_id)` | Setting keys like `language` or `time_format` are shared; each user has their own value.                                                                                                               |
| models         | `(id, user_id)`  | Default models are seeded per user under the same ID (`shared/defaults/models.ts`).                                                                                                                    |
| tasks          | `(id, user_id)`  | Default tasks are seeded per user under the same ID (`src/defaults/tasks.ts`).                                                                                                                         |
| skills         | `(id, user_id)`  | Default skills are seeded per user under the same ID (`src/defaults/skills.ts`).                                                                                                                       |
| model_profiles | `(id, user_id)`  | Per-model inference tuning (temperature, nudges, prompt overrides) seeded per user.                                                                                                                    |
| prompts        | `(id, user_id)`  | Historical. Default automations used to be seeded here; skills superseded them in THU-547 and `reconcileDefaults()` no longer touches `prompts`. The composite key stays for rows written before that. |
| agents         | `(id, user_id)`  | Nothing is seeded — the table holds user-created ACP agents and has no `default_hash` column. The composite key follows the convention of the tables around it.                                        |

`settings` carries one naming quirk worth knowing before you read SQL against it: the key column is physically named `id` "for PowerSync compatibility" and is only accessed as `key` in Drizzle (`backend/src/db/powersync-schema.ts:32`, `src/db/tables.ts:13`). The `(key, user_id)` notation used throughout this document follows the Drizzle schema keys; the constraint on disk is on `(id, user_id)`.

## Tables with Single Primary Key

Tables that hold **user-created** data (chats, messages, devices, etc.) use a single `id` primary key because each row has a globally unique ID:

- chat_threads, chat_messages, triggers, devices, projects

Local-only client tables never reach this schema at all: `mcp_servers`, `mcp_secrets`, `models_secrets`, `integrations_secrets`, `agents_system` and `agents_secrets` are declared in `localOnlyTables` (`src/db/powersync/schema.ts`) and have no backend counterpart.

The authoritative lists are `powersyncTableNames` in `shared/powersync-tables.ts` and the `powersyncPkColumn` / `powersyncConflictTarget` maps in `backend/src/db/powersync-schema.ts`; both maps are typed as `Record<PowerSyncTableName, …>`, so a table missing from either is a compile error. A table dropped from the synced schema moves to `legacyPowerSyncTableNames` (`modes`, `project_files`) rather than disappearing — see [Removing a Synced Table](./powersync-account-devices.md#removing-a-synced-table) for why that entry can never be taken back off the list.

## How It Works

### Frontend (SQLite)

On the frontend, the local SQLite schema uses a single-column primary key because the local database holds one user's data. During initialization, `reconcileDefaults()` in `src/lib/reconcile-defaults.ts` seeds default data into these tables. Overwriting an existing row clears two gates, not one:

- `default_hash` holds the hash of the row as reconcile last wrote it. Re-hashing the stored row and getting something else means the user has edited it, and the row is left alone.
- The bundle's `defaults<X>Version` constant must be strictly newer than the highest version ever applied to this account, recorded under the `defaults_version.*` settings keys (`versionMarkerKeys`, `src/lib/reconcile-defaults.ts`). On a table that already has rows, PowerSync's initial sync must also have completed: until it has, a missing marker cannot be told apart from a marker that simply has not arrived yet, and an older-bundle device would downgrade newer synced rows. A fresh install with no rows bypasses that and seeds offline (`computeCanOverwrite`).

Changing a default without bumping its version constant therefore changes nothing on an existing account. See "Reconciled defaults and version bumps" in `AGENTS.md` for the per-table constants.

### Backend (Postgres, PowerSync)

When PowerSync syncs data to the backend, each user's local data is stored in Postgres. Because multiple users can have rows with the same default ID (two accounts both hold the bundled Opus 5 model row, under the same UUIDv7), the backend schema uses composite primary keys `(id, user_id)` or `(key, user_id)` for those tables.

The `powersyncConflictTarget` map in `backend/src/db/powersync-schema.ts` defines the conflict target for each table. For composite-PK tables, it includes both columns so that `INSERT ... ON CONFLICT` correctly upserts per-user rows.

### PowerSync Upload

When the client uploads PUT operations, the backend uses `user_id` from the JWT to scope operations:

- **INSERT**: Row is inserted with `user_id` from the session. For composite-PK tables, `ON CONFLICT (id, user_id)` or `ON CONFLICT (key, user_id)` is used.
- **PATCH/DELETE**: The `WHERE` clause includes both the row identifier (`id` or `key`) and `user_id` so each user can only affect their own rows.

## Adding New Default-Data Tables

If you add a new table that is seeded with default data at initialization:

1. Use a composite primary key `(id, user_id)` (or `(key, user_id)` for settings-like tables) in the backend PowerSync schema.
2. Add `default_hash` if you want to track user modifications and support reconciling default updates.
3. Update `powersyncConflictTarget` in `backend/src/db/powersync-schema.ts` to include both columns.
4. Update `powersyncPkColumn` if needed (the primary key column used for PATCH/DELETE `WHERE` clauses—the "business" id, not user_id).

---

## Foreign Keys and Indexes

### Why We Don't Use Composite Foreign Keys

While some tables have composite primary keys `(id, user_id)`, we **intentionally do not enforce composite foreign key constraints** for references to these tables. For example:

- `chatMessagesTable.modelId` references `modelsTable` (which has PK `(id, user_id)`)
- We use a simple column-level reference: `modelId: text('model_id')` (no `.references()` or `foreignKey()`)

**Rationale:**

1. **PowerSync architecture**: The backend database is primarily a sync server, not a query engine. Most queries and joins happen on the frontend (SQLite), not the backend.
2. **E2E encryption**: With end-to-end encryption, the backend cannot meaningfully query or enforce relationships in encrypted data.
3. **Performance**: Foreign key constraint checks add overhead to INSERT/UPDATE operations during sync. Since relationships are managed on the frontend, backend FK enforcement provides minimal value.
4. **Flexibility**: Allows client-side data to sync even if relationships are temporarily inconsistent (e.g., during partial syncs).

### Index Strategy: user_id Only

The backend schema uses a **minimal index strategy**:

- **Primary keys** (required for uniqueness)
- **Single `user_id` index** on every table (critical for PowerSync sync rules)
- **No active indexes** (e.g., `WHERE deletedAt IS NULL`)
- **No foreign key indexes** (e.g., `chatThreadId`, `promptId`)

**Rationale:**

1. **PowerSync uses `user_id` for sync rules**: Sync rules filter by `user_id`, so this index is essential for performance.
2. **Queries happen on the frontend**: Complex queries with JOINs, filters, and indexes happen in the local SQLite database, not the backend Postgres.
3. **Storage efficiency**: Each index consumes storage and slows down write operations (INSERT/UPDATE/DELETE during sync).
4. **E2E encryption**: With encrypted data, most backend indexes would be useless anyway since you can't filter or search encrypted columns.

**Exception:** The `user_id` index is essential because PowerSync sync rules always filter by `user_id` to determine which data to sync to each device.

### When Adding New Tables

For any new PowerSync-synced table:

1. ✅ **Do** add a `user_id` column with an index: `index('idx_[table]_user_id').on(table.userId)`
2. ✅ **Do** use composite primary keys for default-data tables (see above)
3. ❌ **Don't** add composite foreign key constraints
4. ❌ **Don't** add active indexes or other query-optimization indexes
5. ❌ **Don't** add indexes on foreign key columns

The backend schema should be optimized for **PowerSync sync operations**, not for complex queries.

Those are the schema rules only. The rest of the procedure — the client schema, the three sync-rule configs, and the two-PR deploy order — is in [Adding a New Synced Table](./powersync-account-devices.md#adding-a-new-synced-table).
