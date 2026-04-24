# Multi-Device Sync

Thunderbolt's multi-device sync is built on [PowerSync](https://powersync.com). Every device holds a local SQLite database; the sync service streams deltas between SQLite and the backend's PostgreSQL. Writes happen locally first, so the app stays snappy offline.

> **Note.** Cross-device sync and optional end-to-end encryption are both in **Preview**. See [roadmap.md](../roadmap.md) for current status.

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

- Every synced table has a `user_id` column. PowerSync's sync rules scope every row to the authenticated user.
- The backend issues short-lived JWTs that PowerSync validates. Rotate `POWERSYNC_JWT_SECRET` to invalidate every outstanding token.
- Client writes go to local SQLite first, then upload to the backend through `PUT /v1/powersync/upload`. The backend applies them in a PostgreSQL transaction.
- A transform-middleware pipeline sits between PowerSync and SQLite. The built-in `encryptionMiddleware` decrypts encrypted columns on download and encrypts them on upload. See [End-to-End Encryption](./e2e-encryption.md).

## Two Sync Paths

There are two distinct pipelines depending on the runtime. Both end with decrypted rows in local SQLite — the transform runs in a different execution context.

| Runtime                    | Path                                    | Why this path                                                     |
| -------------------------- | --------------------------------------- | ----------------------------------------------------------------- |
| Chrome · Edge · Firefox    | Custom **SharedWorker** `ThunderboltSharedSyncImplementation` | One sync connection shared across tabs; the CK stays in the worker |
| Safari · iOS · Tauri       | Main-thread transformer                 | OPFSCoopSyncVFS doesn't support SharedWorker; Tauri blocks it too |

The full write-up is in [powersync-sync-middleware.md](./powersync-sync-middleware.md), including the Vite alias (`powersync-web-internal`) that lets the custom SharedWorker reach into `@powersync/web`'s `@internal` classes.

## Synced Tables

From [`shared/powersync-tables.ts`](../shared/powersync-tables.ts):

| Table            | Purpose                                                           | Primary key      |
| ---------------- | ----------------------------------------------------------------- | ---------------- |
| `settings`       | Per-user preferences                                              | `(key, user_id)` |
| `chat_threads`   | Conversation metadata                                             | `id`             |
| `chat_messages`  | Individual messages within threads                                | `id`             |
| `tasks`          | Todo / task items (defaults seeded per user)                      | `(id, user_id)`  |
| `models`         | Configured model profiles (defaults seeded per user)              | `(id, user_id)`  |
| `modes`          | Custom conversational modes (defaults seeded per user)            | `(id, user_id)`  |
| `prompts`        | Saved prompt templates (defaults seeded per user)                 | `(id, user_id)`  |
| `model_profiles` | Per-model tuning (temperature, prompt overrides) seeded per user  | `(id, user_id)`  |
| `mcp_servers`    | Registered Model Context Protocol servers                         | `id`             |
| `triggers`       | Automations                                                       | `id`             |
| `devices`        | Registered devices for the current account                        | `id`             |

Default-data tables use composite primary keys so multiple users can hold the same default id — see [composite-primary-keys-and-default-data.md](./composite-primary-keys-and-default-data.md).

## Offline Behavior

- Everything you do offline — new chats, sent messages, edits — writes to local SQLite immediately.
- On reconnect, the sync worker replays queued operations through the backend. Conflicts resolve last-writer-wins at the row level.
- *Settings → Devices* shows each device's last-seen time; a stale value means the device hasn't reconnected yet.

## Adding a New Synced Table

Adding a table touches both clients and the backend plus the PowerSync sync rules. To avoid races where clients expect rows the sync service won't stream, ship the change in **two PRs**:

1. **Backend + sync rules PR**
   - Add the table to `backend/src/db/powersync-schema.ts` with a Drizzle migration.
   - Register in [`shared/powersync-tables.ts`](../shared/powersync-tables.ts) (`POWERSYNC_TABLE_NAMES` + `powersyncTableToQueryKeys`).
   - Add the sync rule to `powersync-service/config/config.yaml`.
   - Merge and deploy this first, then update the PowerSync Cloud dashboard rules for production.

2. **Frontend + feature PR**
   - Add the table to `src/db/tables.ts` and `src/db/powersync/schema.ts`.
   - Wire up DAL, defaults, reconciliation, and UI.
   - Merge only after PR 1's sync rules are live.

Deploying the frontend before sync rules are live causes silent sync failure — the table works locally but rows never replicate.

## Indexing Strategy

The backend PostgreSQL schema uses a **minimal index strategy**:

- Primary keys (required)
- A single `user_id` index per table (required for PowerSync sync rules)
- **No** composite foreign keys
- **No** active/soft-delete indexes
- **No** secondary indexes on encrypted columns

Why: the backend is a sync server, not a query engine. Heavy queries run on the client's SQLite. Indexes on encrypted columns would be useless anyway, and fewer indexes means faster writes during sync. Full rationale in [composite-primary-keys-and-default-data.md](./composite-primary-keys-and-default-data.md).

## Related Reading

- [PowerSync, Account & Device Management](./powersync-account-devices.md) — how devices are registered and revoked.
- [End-to-End Encryption](./e2e-encryption.md) — how the sync pipeline encrypts data before it reaches the server.
- [Quick Start](../development/quick-start.md) and [Testing](../development/testing.md) — schema rules, composite keys, and the migration checklist.
