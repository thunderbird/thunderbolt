# User Data Export Format

Versioned, table-keyed JSON snapshot from **Settings → Preferences → Export My Data**: chats, tasks, models, MCP servers, agents, skills, prompts, settings, and the user-typed API keys pairing with those rows. The import flow (THU-597) reads `schemaVersion` to branch its restore logic.

## File format

Plain JSON named `thunderbolt-export-YYYY-MM-DD.json`, from a blob with `Content-Type: application/json` ([`src/lib/export-download.ts`](../../../src/lib/export-download.ts)). The date is the user's local calendar day, not UTC. Nothing is compressed on either side. Inspect with `jq . thunderbolt-export-….json`.

The file picker accepts `application/json,.json`, and the importer refuses a file over 200 MB by checking `File.size` before reading anything ([`src/lib/import-upload.ts`](../../../src/lib/import-upload.ts)): the `file.text()` allocation would freeze or OOM the WebView on Tauri iOS.

## Envelope

<!-- prettier-ignore -->
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
    "projects":        [ /* full rows */ ],
    "prompts":         [ /* full rows */ ],
    "skills":          [ /* full rows */ ],
    "triggers":        [ /* full rows */ ],
    "agents":          [ /* full rows */ ],
    "models_secrets":  [ /* full rows */ ],
    "mcp_servers":     [ /* full rows */ ],
    "mcp_secrets":     [ /* full rows */ ],
    "agents_secrets":  [ /* full rows */ ]
  }
}
```

Rows are whatever Drizzle's `select()` returns: no renaming, no nesting. JSON-mode columns (`chat_messages.parts`, `.metadata`, `.cache`, `model_profiles.providerOptions`) are parsed objects, not strings.

## Schema versions

| `schemaVersion` | Source app state                                 | Notes                                                                                             |
| --------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| `1`             | Pre-Workspaces-v1. Every row is `userId`-scoped. | Rows have no `workspaceId`. Importer (THU-597) assigns rows to a target workspace at import time. |

`schemaVersion: 2` lands with Workspaces v1: `workspaceId` on each row plus a workspace manifest section.

## Scoping (why there's no per-user filter)

The local SQLite file is already single-user: PowerSync syncs down only rows the JWT allows, anonymous and standalone DBs never see anyone else's data, and sign-out wipes the file. The exporter selects rows verbatim, with no `userId` predicate and no joins. The envelope's `user` field is informational.

## How the included table list is derived

The exporter walks the same name → Drizzle table map PowerSync uses (`syncedTables` + `localOnlyTables` in [`src/db/powersync/schema.ts`](../../../src/db/powersync/schema.ts)) minus the `excludedFromExport` set in [`src/dal/export.ts`](../../../src/dal/export.ts). A new schema table is opted in automatically, so the export test pins an explicit allowlist: the next PR must confirm it belongs in the backup or add it to `excludedFromExport` (and this doc).

## Included tables

**Synced (PowerSync) tables.** Soft-deleted rows are included; the importer decides how to restore them.

- `settings`, `chat_threads`, `chat_messages`, `tasks`, `models`, `model_profiles`, `prompts`, `skills`, `triggers`, `agents`, `projects`.

**Local-only tables.** User-typed credentials and config that don't sync.

- `models_secrets`: API keys for custom model providers.
- `mcp_servers`: MCP server configurations.
- `mcp_secrets`: bearer tokens / API keys / OAuth tokens for MCP servers.
- `agents_secrets`: API keys for user-created ACP agents.

## Excluded tables

- `devices`: per-device trust state. Trust is between specific device keys, so the rows would be misleading on another device.
- `integrations_secrets`: Google / Microsoft OAuth tokens. The importing user re-authenticates; tokens are usually expired or revoked anyway.
- `agents_system`: system-provided ACP agents (e.g. Haystack) hydrated from the backend `/agents` discovery endpoint, not user content.

## Encryption

With E2E encryption enabled, synced columns arrive in local SQLite **already decrypted** by the sync middleware ([`powersync-sync-middleware.md`](powersync-sync-middleware.md)). The export reads the local DB, so `chat_messages.content`, `chat_messages.parts` and other encrypted columns are plaintext in the file.

## Import behavior

`src/dal/import.ts`, surfaced as **Settings → Preferences → Data → Import Data**.

- **Validation.** `format !== "thunderbolt-export"` or `schemaVersion !== 1` is rejected with an `ImportFormatError`, before any DB write.
- **Upsert semantics, imported file wins.** Each row is a PK lookup then `UPDATE` or `INSERT`; local rows whose PK is _not_ in the file are untouched. `INSERT ... ON CONFLICT DO UPDATE` is deliberately avoided: PowerSync exposes synced tables as SQLite _views_, and SQLite forbids upserts against a view ("cannot UPSERT a view").
- **Cross-device propagation (synced tables only).** Rows are queued in PowerSync's CRUD log and fanned out to every other signed-in device, so restoring an old backup overwrites newer rows everywhere they share an ID. **Local-only tables stay local**: `models_secrets`, `mcp_secrets`, and `agents_secrets` never upload, so a different device gets the configs that need keys but not the keys. The confirm dialog states the overwrite and the fan-out.
- **`userId` re-stamped from the session.** On synced tables the row's `userId` is overwritten with the signed-in user's id; the file's value is never trusted. Local-only secret tables have no `user_id` column. The backend's upload route enforces the same invariant from the JWT (`backend/src/dal/powersync.ts`).
- **Soft-deleted rows preserved.** `deletedAt` rides through verbatim.
- **Atomic.** One `db.transaction`; any row-level failure rolls back every preceding write.
- **Forward-compatible at the table level only.** Unrecognized table keys land in `ignoredTableNames` and are skipped. Columns are **not**: Drizzle builds the SQL column list from each row's keys, so an unknown column raises `no column named …` and rolls back. Future schemaVersions adding columns must bump the version (v1 then rejects the file outright) or strip unknown keys.
- **No cross-table consistency check.** The synced schema has no real FK constraints (per `multi-device-sync.md`), so there is no insertion order: a `chat_messages` row referencing a missing `chat_threads.id` is inserted as an orphan.

### Account-mismatch guard

No DB write happens until the user confirms, and the dialog is built from a read-only preview. `summarizeExportEnvelope` ([`src/dal/import.ts`](../../../src/dal/import.ts)) re-checks the envelope shape and returns the total row count, the formatted `exportedAt`, and the exporting user's email; `src/settings/preferences.tsx` calls it as soon as the file is picked. When both emails exist and differ (case-insensitively), it sets `accountMismatch` and the dialog adds a destructive-styled warning.

Email rather than `user.id`, because Better Auth issues a new id when an account is deleted and recreated while the email stays stable. It stays `false` when either side is missing, so a legacy export without an email raises no false alarm. The mistake is unrecoverable: the `userId` re-stamp makes foreign rows indistinguishable from the user's own, and the fan-out carries them to every signed-in device.

### Post-Workspaces follow-up

Once every user-content table carries a `workspaceId`, workspace handling stays deterministic and UI-free (no picker).

- **v1 files (no `workspaceId`):** rows are stamped with the default workspace's id on insert.
- **v2+ files (rows carry `workspaceId`):** preserved verbatim. If the workspace is missing locally, the importer creates it (or skips the row, TBD when v2 ships).

## Known limitations (v1)

- **In-memory payload.** The whole export is built in memory before download; heavy users (~tens of thousands of messages) see slower exports. A streaming variant is a follow-up if files cross ~100 MB in practice.
- **Plaintext at rest.** No encryption-at-rest on the file; users should treat it like their account password.
- **No backup of E2E key material.** The Content Key lives in the device's keyring (see [`e2e-encryption.md`](e2e-encryption.md)). Importing on a different device requires the standard device-approval flow.
