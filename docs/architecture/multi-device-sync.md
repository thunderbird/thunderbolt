# Multi-Device Sync

Built on [PowerSync](https://powersync.com). Every device holds a local SQLite database; the sync service streams deltas between it and the backend's PostgreSQL. Writes land locally first.

> **Note.** Cross-device sync and optional end-to-end encryption are in **Preview**.

## How It Works

```
┌──────────┐   reads/writes   ┌──────────┐   transform        ┌────────────┐
│  Client  │ ───────────────▶ │  SQLite  │ ──(sync worker)──▶ │ PowerSync  │
│          │                  │  (local) │                    │  Service   │
└──────────┘                  └──────────┘                    └─────┬──────┘
                                                                    │ logical
                                                                    │ replication
                                                                    ▼
                                                             ┌──────────────┐
                                                             │  PostgreSQL  │
                                                             │  (backend)   │
                                                             └──────────────┘
```

- Sync rules scope every row to the authenticated user via each table's `user_id` column.
- Short-lived backend-issued JWTs, validated by PowerSync, authenticate the stream; rotate `POWERSYNC_JWT_SECRET` to invalidate every outstanding token.
- Local writes upload through `PUT /v1/powersync/upload`, applied in one PostgreSQL transaction.
- Transform middleware sits between PowerSync and SQLite; `encryptionMiddleware` decrypts encrypted columns on download, encrypts on upload ([E2E encryption](./e2e-encryption.md)).

## Two Sync Paths

Both run the transform off the UI thread in a worker hosting the same `ThunderboltSharedSyncImplementation`; only the worker _kind_ differs.

| Runtime                 | Path                                                  | Why this path                                                                                          |
| ----------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Chrome · Edge · Firefox | Custom **SharedWorker**                               | One sync connection shared across tabs; the content key stays in the worker                            |
| Safari · iOS · Tauri    | Dedicated **Worker** standing in for the SharedWorker | OPFSCoopSyncVFS and `tauri://` rule out SharedWorker, so a dedicated Worker hosts the same sync stream |

The Vite alias `powersync-web-internal` lets the custom SharedWorker reach `@powersync/web`'s `@internal` classes; see [powersync-sync-middleware.md](./powersync-sync-middleware.md).

## Synced Tables

From [`shared/powersync-tables.ts`](../../shared/powersync-tables.ts):

| Table            | Purpose                                                                        | Primary key      |
| ---------------- | ------------------------------------------------------------------------------ | ---------------- |
| `settings`       | Per-user preferences                                                           | `(key, user_id)` |
| `chat_threads`   | Conversation metadata                                                          | `id`             |
| `chat_messages`  | Individual messages within threads                                             | `id`             |
| `tasks`          | Todo / task items (defaults seeded per user)                                   | `(id, user_id)`  |
| `models`         | Configured models: provider, endpoint, capabilities (defaults seeded per user) | `(id, user_id)`  |
| `prompts`        | Saved prompt templates (defaults seeded per user)                              | `(id, user_id)`  |
| `skills`         | Slash-command skills (defaults seeded per user)                                | `(id, user_id)`  |
| `triggers`       | Automations                                                                    | `id`             |
| `model_profiles` | Per-model tuning (temperature, prompt overrides) seeded per user               | `(id, user_id)`  |
| `devices`        | Registered devices for the current account                                     | `id`             |
| `agents`         | User-created ACP agents (built-ins and system agents are not rows)             | `(id, user_id)`  |
| `projects`       | Project workspaces (durable instructions)                                      | `id`             |

Default-data tables use composite primary keys so multiple users can hold the same default id ([details](./composite-primary-keys-and-default-data.md)).

## Local-Only Tables

`src/db/powersync/schema.ts` splits the client schema into `syncedTables` (the twelve above) and `localOnlyTables`. The latter carry `options: { localOnly: true }`: created in SQLite, never streamed.

| Table                  | Holds                                                                     |
| ---------------------- | ------------------------------------------------------------------------- |
| `models_secrets`       | Model API keys                                                            |
| `integrations_secrets` | Google / Microsoft OAuth tokens                                           |
| `mcp_servers`          | MCP server configuration                                                  |
| `mcp_secrets`          | MCP bearer tokens / API keys                                              |
| `agents_system`        | System-provided ACP agents, hydrated from the backend `/agents` discovery |
| `agents_secrets`       | ACP agent credentials                                                     |

- `models` + `models_secrets` and `agents` + `agents_secrets` sync the config row, keep the credential on-device. Both MCP halves stay local: a replicated server entry without its credentials is one no other device can connect to. `agents_system` caches a backend response the other device can fetch itself.
- `src/dal/mcp-servers.ts` writes both MCP halves in one transaction (`createMcpServerWithCredentials`, `updateMcpServerWithCredentials`); connect-time code reads the secret, so a partial write orphans it or connects unauthenticated.
- Invariant: **nothing carrying a credential may join `syncedTables`**; confirm a new entry holds no secret. Only `mcp_servers` and `mcp_secrets` have a regression test (`src/db/powersync/schema.test.ts`); the other four rely on review.

## Offline Behavior

- Offline work writes to local SQLite immediately.
- On reconnect, the worker replays queued operations. Conflicts resolve last-writer-wins per row.
- _Settings → Devices_ shows last-seen times; a stale value means that device hasn't reconnected.

## Adding a New Synced Table

Two PRs. First: backend schema, migration, `shared/powersync-tables.ts`, all three sync-rule configs. Second, once the new `thunderbolt-powersync` image is live: frontend schema and feature code. Frontend-first fails silently, the table working locally while rows never replicate.

Full procedure (`user_id`-index-only rule, bucket and sync-priority choice, removing a table, adding a column): [Adding a New Synced Table](./powersync-account-devices.md#adding-a-new-synced-table).

## Indexing Strategy

Primary keys and one `user_id` index per table, nothing else: Postgres is a sync server here, not a query engine, and heavy queries run against the client's SQLite. [Rationale](./composite-primary-keys-and-default-data.md#index-strategy-user_id-only).

## Related Reading

- [PowerSync, Account & Device Management](./powersync-account-devices.md): device registration and revocation.
- [End-to-End Encryption](./e2e-encryption.md)
- [Quick Start](../development/quick-start.md), [Testing](../development/testing.md): schema rules, composite keys, migration checklist.
