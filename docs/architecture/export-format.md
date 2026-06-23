# User Data Export Format

Versioned, table-keyed JSON snapshot produced by **Settings → Preferences → Export My Data**. The export is a backup of the signed-in user's local data — chats, tasks, models, MCP servers, agents, skills, prompts, modes, settings, and the user-typed API keys that pair with those rows.

The companion import flow (THU-597) consumes the same format and reads `schemaVersion` to branch its restore logic.

## File format

The download is **gzipped JSON** — `thunderbolt-export-YYYY-MM-DD.json.gz`, `Content-Type: application/gzip`. The envelope inside the archive is the JSON described below. Chat-message JSON compresses to ~10-15% of its original size, which keeps even heavy-user backups well under the importer's 200 MB on-disk cap. To inspect: `gunzip -c thunderbolt-export-…json.gz | jq .`.

The importer detects gzip by magic bytes (`1f 8b`, RFC 1952), so a hand-decompressed `.json` from the same envelope still imports cleanly — the `.gz` is a transport detail, not part of the schema version.

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

## Import behavior

The companion importer (`src/dal/import.ts`, surfaced as **Settings → Preferences → Data → Import Data**) consumes the same envelope.

- **Validation.** The importer rejects anything where `format !== "thunderbolt-export"` or `schemaVersion !== 1` with a `ImportFormatError`. No DB writes happen until validation passes.
- **Upsert semantics — imported file wins.** Each row is written by checking for an existing PK row first and then either `UPDATE`ing (imported file wins) or `INSERT`ing. Local rows whose PK is *not* in the file are left untouched. We deliberately avoid `INSERT ... ON CONFLICT DO UPDATE`: PowerSync exposes synced tables as SQLite *views*, and SQLite forbids upserts against a view ("cannot UPSERT a view"). The SELECT + UPDATE/INSERT split works on both real tables and PowerSync views. This matches the "restore my backup" intent the user selected; the confirmation dialog spells the destructiveness out.
- **Cross-device propagation (synced tables only).** Imports write through the same path as any other local change to a synced table: the new rows are queued in PowerSync's CRUD log and uploaded to the backend, which fans them out to every other device the user is signed in to. Restoring an old backup overwrites newer rows everywhere they share an ID, not just on the device running the import. The confirm dialog spells this out. **Local-only tables stay local on import**: `models_secrets`, `mcp_secrets`, and `agents_secrets` write to the device's SQLite file but never upload — synced rows fan out, paired credentials do not. Importing on a different device therefore restores the configs that need keys but expects the user to re-import or re-enter the keys per device.
- **`userId` re-stamped from the session.** On every synced table the importer overwrites the row's `userId` with the currently signed-in user's id; the value carried in the file is never trusted. Local-only secret tables (`models_secrets`, `mcp_secrets`, `agents_secrets`) have no `user_id` column and are untouched by this rule. The backend's PowerSync upload route enforces the same invariant from the JWT (see `backend/src/dal/powersync.ts`); the FE importer matches that boundary so the local row never carries a foreign id even momentarily.
- **Soft-deleted rows preserved.** `deletedAt` rides through verbatim — a row in the trash in the file remains in the trash after import.
- **Atomic.** The whole import runs inside a single `db.transaction`. A single row-level failure (e.g. a constraint violation) rolls back every preceding write in the call.
- **Forward-compatible at the table level only.** Table keys in the file that the importer doesn't recognize (e.g. tables added in a future `schemaVersion`) are surfaced in `ignoredTableNames` and otherwise skipped silently. Column-level additions are **not** forward-compatible: Drizzle builds the SQL column list from each row's own keys, so an unknown column on a recognized table raises `no column named …` and rolls back the whole transaction. Future schemaVersions that add columns must bump the version (so v1 rejects the file outright) or extend the importer to strip unknown keys.
- **No cross-table consistency check.** There are no real FK constraints in the synced schema (per `multi-device-sync.md`), so the importer doesn't enforce an insertion order. A `chat_messages` row that references a missing `chat_threads.id` will be inserted as an orphan.

### Post-Workspaces follow-up

Once Workspaces v1 lands and every user-content table carries a `workspaceId` column, the importer's workspace handling becomes **deterministic, no UI**:

- **v1 files (no `workspaceId` on rows)** — rows are stamped with the default workspace's id on insert (the user's Default / Personal Workspace). No selector, no prompt.
- **Future v2+ files (rows carry `workspaceId`)** — the row's existing `workspaceId` is preserved verbatim. If the workspace doesn't exist locally yet, the importer creates it (or skips the row — TBD when v2 ships). The importing user never picks a target.

This keeps the UX identical to v1 (one button, one confirm dialog, no extra picker) and lets backups round-trip across devices without losing workspace structure.

When v2 ships, a `schemaVersion: 2` will be defined for exports produced on the workspaces-v1 build. v1 files (no `workspaceId`) stay importable under the rule above.

## Known limitations (v1)

- **In-memory payload.** The whole export is built in memory before download. Heavy users (~tens of thousands of messages) will see slower exports; a streaming / chunked variant is a follow-up if the file ever crosses ~100 MB in practice.
- **Plaintext at rest in the file.** No encryption-at-rest on the export file itself. The UI copy makes the sensitivity clear; users should treat the file as they would their account password.
- **No backup of E2E key material.** The Content Key lives in the device's keyring (see [`e2e-encryption.md`](./e2e-encryption.md)). Importing on a different device requires the standard device-approval flow; the export only carries the user-facing data, not the cryptographic state.
