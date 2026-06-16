# User Data Export Format

Versioned, table-keyed JSON snapshot produced by **Settings → Preferences → Export My Data**. The export is a backup of the signed-in user's local data — chats, tasks, models, MCP servers, agents, skills, prompts, modes, settings, and the user-typed API keys that pair with those rows.

The companion import flow (THU-597) consumes the same format and reads `schemaVersion` to branch its restore logic.

## Envelope

```jsonc
{
  "format": "thunderbolt-export",
  "schemaVersion": 1,
  "exportedAt": "2026-06-16T12:34:56.789Z",
  "user": { "id": "<userId>", "email": "<email-or-null>" },
  "tables": {
    "settings":        [ /* full rows */ ],
    "chat_threads":    [ /* full rows */ ],
    "chat_messages":   [ /* full rows */ ],
    "tasks":           [ /* full rows */ ],
    "models":          [ /* full rows */ ],
    "model_profiles":  [ /* full rows */ ],
    "prompts":         [ /* full rows */ ],
    "skills":          [ /* full rows */ ],
    "triggers":        [ /* full rows */ ],
    "modes":           [ /* full rows */ ],
    "agents":          [ /* full rows */ ],
    "models_secrets":  [ /* full rows */ ],
    "mcp_servers":     [ /* full rows */ ],
    "mcp_secrets":     [ /* full rows */ ],
    "agents_secrets":  [ /* full rows */ ]
  }
}
```

Rows are whatever Drizzle's `select()` returns against each table — no field renaming, no nested restructuring. JSON-mode columns (`chat_messages.parts`, `chat_messages.metadata`, `chat_messages.cache`, `model_profiles.providerOptions`) are parsed objects, not strings.

## Schema versions

| `schemaVersion` | Source app state                                 | Notes                                                                                            |
| --------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| `1`             | Pre-Workspaces-v1. Every row is `userId`-scoped. | Rows have no `workspaceId`. Importer (THU-597) assigns rows to a target workspace at import time. |

When Workspaces v1 lands, a `schemaVersion: 2` will be defined with `workspaceId` on each row and a workspace manifest section.

## Scoping (why there's no per-user filter)

The local SQLite file is already single-user: PowerSync only syncs down rows the JWT is allowed to see, anonymous and standalone DBs never see anyone else's data, and sign-out wipes the file. The exporter therefore selects rows verbatim from each included table — no `userId` predicate, no joins. The `user` field in the envelope is informational metadata about who ran the export.

## How the included table list is derived

The exporter walks the same name → Drizzle table map PowerSync uses (`syncedTables` + `localOnlyTables` in [`src/db/powersync/schema.ts`](../../src/db/powersync/schema.ts)) and drops anything in the `excludedFromExport` set in [`src/dal/export.ts`](../../src/dal/export.ts). Adding a new table to the schema automatically opts it into exports — the export test enforces an explicit allowlist so the next PR has to confirm "yes, this belongs in the user backup" or add it to `excludedFromExport` (and the consumer doc) at the same time.

## Included tables

**Synced (PowerSync) tables.** Soft-deleted rows are included — the importer decides whether to restore them as soft-deleted, fully deleted, or live.

- `settings`, `chat_threads`, `chat_messages`, `tasks`, `models`, `model_profiles`, `prompts`, `skills`, `triggers`, `modes`, `agents`.

**Local-only tables** — user-typed credentials and config that don't sync.

- `models_secrets` — API keys you entered for custom model providers.
- `mcp_servers` — your MCP server configurations.
- `mcp_secrets` — bearer tokens / API keys / OAuth tokens for MCP servers.
- `agents_secrets` — API keys for user-created ACP agents.

## Excluded tables

By design — these are either operational state, third-party credentials, or backend-hydrated catalogs that don't belong in a portable backup.

- `devices` — per-device trust state. Trust is between specific device keys; re-importing on another device would make these rows misleading.
- `integrations_secrets` — Google / Microsoft OAuth tokens. The importing user re-authenticates the integration; tokens are often expired or revoked anyway.
- `agents_system` — system-provided ACP agents (e.g. Haystack) hydrated from the backend `/agents` discovery endpoint, not user content.

## Encryption

When E2E encryption is enabled, columns that ride the sync layer arrive in local SQLite **already decrypted** by the sync middleware (see [`powersync-sync-middleware.md`](./powersync-sync-middleware.md)). The export reads the local DB, so `chat_messages.content` / `chat_messages.parts` and other encrypted columns appear in plaintext in the export.

## Known limitations (v1)

- **In-memory payload.** The whole export is built in memory before download. Heavy users (~tens of thousands of messages) will see slower exports; a streaming / chunked variant is a follow-up if the file ever crosses ~100 MB in practice.
- **Plaintext at rest in the file.** No encryption-at-rest on the export file itself. The UI copy makes the sensitivity clear; users should treat the file as they would their account password.
- **No backup of E2E key material.** The Content Key lives in the device's keyring (see [`e2e-encryption.md`](./e2e-encryption.md)). Importing on a different device requires the standard device-approval flow; the export only carries the user-facing data, not the cryptographic state.
