# Multi-Device Sync

Thunderbolt's multi-device sync is built on [PowerSync](https://powersync.com). Every device holds a local SQLite database; the sync service streams deltas between SQLite and the backend's PostgreSQL. Writes happen locally first, so the app stays snappy offline.

> **Note.** Cross-device sync and optional end-to-end encryption are both in **Preview**.

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

The runtime picks one of two pipelines. Both run the transform off the UI thread, in a worker hosting the same `ThunderboltSharedSyncImplementation` — only the worker _kind_ differs.

| Runtime                 | Path                                                  | Why this path                                                                                          |
| ----------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Chrome · Edge · Firefox | Custom **SharedWorker**                               | One sync connection shared across tabs; the content key stays in the worker                            |
| Safari · iOS · Tauri    | Dedicated **Worker** standing in for the SharedWorker | OPFSCoopSyncVFS and `tauri://` rule out SharedWorker, so a dedicated Worker hosts the same sync stream |

The full write-up is in [powersync-sync-middleware.md](./powersync-sync-middleware.md), including the Vite alias (`powersync-web-internal`) that lets the custom SharedWorker reach into `@powersync/web`'s `@internal` classes.

## Synced Tables

From [`shared/powersync-tables.ts`](../../shared/powersync-tables.ts):

| Table            | Purpose                                                                         | Primary key      |
| ---------------- | ------------------------------------------------------------------------------- | ---------------- |
| `settings`       | Per-user preferences                                                            | `(key, user_id)` |
| `chat_threads`   | Conversation metadata                                                           | `id`             |
| `chat_messages`  | Individual messages within threads                                              | `id`             |
| `tasks`          | Todo / task items (defaults seeded per user)                                    | `(id, user_id)`  |
| `models`         | Configured models — provider, endpoint, capabilities (defaults seeded per user) | `(id, user_id)`  |
| `prompts`        | Saved prompt templates (defaults seeded per user)                               | `(id, user_id)`  |
| `skills`         | Slash-command skills (defaults seeded per user)                                 | `(id, user_id)`  |
| `triggers`       | Automations                                                                     | `id`             |
| `model_profiles` | Per-model tuning (temperature, prompt overrides) seeded per user                | `(id, user_id)`  |
| `devices`        | Registered devices for the current account                                      | `id`             |
| `agents`         | User-created ACP agents (built-ins and system agents are not rows)              | `(id, user_id)`  |
| `projects`       | Project workspaces (durable instructions)                                       | `id`             |

Default-data tables use composite primary keys so multiple users can hold the same default id — see [composite-primary-keys-and-default-data.md](./composite-primary-keys-and-default-data.md).

## Local-Only Tables

`src/db/powersync/schema.ts` splits the client schema in two: `syncedTables` (the twelve above) and `localOnlyTables`, registered with `options: { localOnly: true }` so PowerSync creates them in SQLite but never streams them.

| Table                  | Holds                                                                     |
| ---------------------- | ------------------------------------------------------------------------- |
| `models_secrets`       | Model API keys                                                            |
| `integrations_secrets` | Google / Microsoft OAuth tokens                                           |
| `mcp_servers`          | MCP server configuration                                                  |
| `mcp_secrets`          | MCP bearer tokens / API keys                                              |
| `agents_system`        | System-provided ACP agents, hydrated from the backend `/agents` discovery |
| `agents_secrets`       | ACP agent credentials                                                     |

Three of them are the local half of a pair: `models` + `models_secrets` and `agents` + `agents_secrets` sync the config row and keep the credential on-device; `mcp_servers` + `mcp_secrets` pairs the same way but keeps both halves local. `src/dal/mcp-servers.ts` writes both halves in one transaction (`createMcpServerWithCredentials`, `updateMcpServerWithCredentials`) because the connection code reads the secret at connect time, so a partial write would either orphan the secret or connect unauthenticated.

`mcp_servers` is local-only for a different reason than the secrets tables: replicating a server entry without its (local-only) credentials would hand every other device a server it cannot connect to. `agents_system` is a cache of a backend response, so syncing it would duplicate a source the other device can fetch for itself.

The invariant: **nothing carrying a credential may join `syncedTables`.** Adding a table there means confirming it holds no secret. Only `mcp_servers` and `mcp_secrets` have a regression test (`src/db/powersync/schema.test.ts`); the other four rely on review.

## Offline Behavior

- Everything you do offline — new chats, sent messages, edits — writes to local SQLite immediately.
- On reconnect, the sync worker replays queued operations through the backend. Conflicts resolve last-writer-wins at the row level.
- _Settings → Devices_ shows each device's last-seen time; a stale value means the device hasn't reconnected yet.

## Adding a New Synced Table

Adding a table touches both clients, the backend schema, and the PowerSync sync rules, so it ships as **two PRs**: backend schema + migration + `shared/powersync-tables.ts` + all three sync-rule configs first, then the frontend schema and feature code once the new `thunderbolt-powersync` image is live. Shipping the frontend first causes silent sync failure — the table works locally but rows never replicate.

The full procedure, including the `user_id`-index-only rule, which bucket (and therefore which sync priority) the new rule belongs in, and how to remove a table or add a column to an existing one, is in [Adding a New Synced Table](./powersync-account-devices.md#adding-a-new-synced-table).

## Indexing Strategy

The backend Postgres schema carries primary keys and one `user_id` index per table, and nothing else — it is a sync server, not a query engine, and heavy queries run against the client's SQLite. Full rationale in [Index Strategy: user_id Only](./composite-primary-keys-and-default-data.md#index-strategy-user_id-only).

## Related Reading

- [PowerSync, Account & Device Management](./powersync-account-devices.md) — how devices are registered and revoked.
- [End-to-End Encryption](./e2e-encryption.md) — how the sync pipeline encrypts data before it reaches the server.
- [Quick Start](../development/quick-start.md) and [Testing](../development/testing.md) — schema rules, composite keys, and the migration checklist.
