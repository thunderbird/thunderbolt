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
