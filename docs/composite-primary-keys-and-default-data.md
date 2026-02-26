# Composite Primary Keys and Default Data

This document describes why certain tables use composite primary keys `(id, user_id)` or `(key, user_id)` and how this design supports default data that is seeded at initialization.

## Overview

Several tables hold data that is **seeded as defaults** when a user first initializes the app (or when a new device connects via PowerSync). These defaults share the same IDs across users (e.g. `openai-gpt-4o`, `default-mode`, `theme`). To allow each user to have their own row with the same default ID, these tables use **composite primary keys** that include `user_id`.

## Tables with composite primary keys

| Table   | Composite key   | Reason |
|---------|------------------|--------|
| settings| `(key, user_id)` | Setting keys like `theme` or `model_id` are shared; each user has their own value. |
| models  | `(id, user_id)`  | Default models (e.g. `openai-gpt-4o`) are seeded per user with same ID. |
| modes   | `(id, user_id)`  | Default modes (e.g. `default-mode`) are seeded per user with same ID. |
| tasks   | `(id, user_id)`  | Default tasks (e.g. `inbox`) are seeded per user with same ID. |
| prompts | `(id, user_id)`  | Default automations/prompts are seeded per user with same ID. |
| model_profiles | `(id, user_id)` | Per-model inference tuning (temperature, nudges, prompt overrides) seeded per user. |

## Tables with single primary key

Tables that hold **user-created** data (chats, messages, devices, etc.) use a single `id` primary key because each row has a globally unique ID:

- chat_threads, chat_messages, mcp_servers, triggers, devices

## How it works

### Frontend (SQLite)

On the frontend, the local SQLite schema uses a single-column primary key (`id` or `key`) because data is per-device and not yet multi-user. During initialization, `reconcileDefaults()` in `src/lib/reconcile-defaults.ts` seeds default data into these tables. The `default_hash` column tracks whether the user has modified a default row; unmodified rows can be updated when app defaults change.

### Backend (Postgres, PowerSync)

When PowerSync syncs data to the backend, each user's local data is stored in Postgres. Because multiple users can have rows with the same default ID (e.g. two users both have a model with id `openai-gpt-4o`), the backend schema uses composite primary keys `(id, user_id)` or `(key, user_id)` for those tables.

The `powersyncConflictTarget` map in `backend/src/db/powersync-schema.ts` defines the conflict target for each table. For composite-PK tables, it includes both columns so that `INSERT ... ON CONFLICT` correctly upserts per-user rows.

### PowerSync upload

When the client uploads PUT operations, the backend uses `user_id` from the JWT to scope operations:

- **INSERT**: Row is inserted with `user_id` from the session. For composite-PK tables, `ON CONFLICT (id, user_id)` or `ON CONFLICT (key, user_id)` is used.
- **PATCH/DELETE**: The `WHERE` clause includes both the row identifier (`id` or `key`) and `user_id` so each user can only affect their own rows.

## Adding new default-data tables

If you add a new table that is seeded with default data at initialization:

1. Use a composite primary key `(id, user_id)` (or `(key, user_id)` for settings-like tables) in the backend PowerSync schema.
2. Add `default_hash` if you want to track user modifications and support reconciling default updates.
3. Update `powersyncConflictTarget` in `backend/src/db/powersync-schema.ts` to include both columns.
4. Update `powersyncPkColumn` if needed (the primary key column used for PATCH/DELETE `WHERE` clauses—the "business" id, not user_id).

---

## Foreign keys and indexes

### Why we don't use composite foreign keys

While some tables have composite primary keys `(id, user_id)`, we **intentionally do not enforce composite foreign key constraints** for references to these tables. For example:

- `chatThreadsTable.modeId` references `modesTable` (which has PK `(id, user_id)`)
- We use a simple column-level reference: `modeId: text('mode_id')` (no `.references()` or `foreignKey()`)

**Rationale:**

1. **PowerSync architecture**: The backend database is primarily a sync server, not a query engine. Most queries and joins happen on the frontend (SQLite), not the backend.
2. **E2E encryption**: With end-to-end encryption, the backend cannot meaningfully query or enforce relationships in encrypted data.
3. **Performance**: Foreign key constraint checks add overhead to INSERT/UPDATE operations during sync. Since relationships are managed on the frontend, backend FK enforcement provides minimal value.
4. **Flexibility**: Allows client-side data to sync even if relationships are temporarily inconsistent (e.g., during partial syncs).

### Index strategy: user_id only

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

### When adding new tables

For any new PowerSync-synced table:

1. ✅ **Do** add a `user_id` column with an index: `index('idx_[table]_user_id').on(table.userId)`
2. ✅ **Do** use composite primary keys for default-data tables (see above)
3. ❌ **Don't** add composite foreign key constraints
4. ❌ **Don't** add active indexes or other query-optimization indexes
5. ❌ **Don't** add indexes on foreign key columns

The backend schema should be optimized for **PowerSync sync operations**, not for complex queries.
