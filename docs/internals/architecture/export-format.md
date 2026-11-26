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

The local SQLite file is already single-user: PowerSync syncs down only rows the JWT allows, anonymous and standalone DBs never see anyone else's data, and sign-out wipes the file. The exporter selects user rows without a `userId` predicate. Provider credentials are filtered to API-key connections with a matching local binding; OAuth tokens are never exported. The envelope's `user` field is informational.

## How the included table list is derived

The exporter walks the same name → Drizzle table map PowerSync uses (`syncedTables` + `localOnlyTables` in [`src/db/powersync/schema.ts`](../../../src/db/powersync/schema.ts)) minus the `excludedFromExport` set in [`src/dal/export.ts`](../../../src/dal/export.ts). A new schema table is opted in automatically, so the export test pins an explicit allowlist: the next PR must confirm it belongs in the backup or add it to `excludedFromExport` (and this doc).

## Included tables

**Synced (PowerSync) tables.** Soft-deleted rows are included; the importer decides how to restore them.

- `settings`, `chat_threads`, `chat_messages`, `tasks`, `models`, `model_profiles`, `prompts`, `skills`, `triggers`, `agents`, `projects`, `provider_connections`.

**Local-only tables.** User-typed credentials and config that don't sync.

- `models_secrets`: API keys for custom model providers.
- `mcp_servers`: MCP server configurations.
- `mcp_secrets`: bearer tokens / API keys / OAuth tokens for MCP servers.
- `agents_secrets`: API keys for user-created ACP agents.

## Excluded tables

- `devices`: per-device trust state. Trust is between specific device keys, so the rows would be misleading on another device.
- `integrations_secrets`: Google / Microsoft OAuth tokens. The importing user re-authenticates; tokens are usually expired or revoked anyway.
- `agents_system`: system-provided agents (Haystack's ACP agents, the hosted agent) hydrated from the backend `/agents` discovery endpoint, not user content.

## Encryption

Encrypted synced columns arrive in local SQLite **already decrypted** by the sync middleware ([`powersync-sync-middleware.md`](powersync-sync-middleware.md)). The export reads the local DB, so `chat_messages.content`, `chat_messages.parts` and other encrypted columns are plaintext in the file.

## Import behavior

`src/dal/import.ts`, surfaced as **Settings → Preferences → Data → Import Data**.

- **Validation.** `format !== "thunderbolt-export"` or `schemaVersion !== 1` is rejected with an `ImportFormatError`, before any DB write.
- **Upsert semantics, imported file wins.** Each row is a PK lookup then `UPDATE` or `INSERT`; local rows whose PK is _not_ in the file are untouched. `INSERT ... ON CONFLICT DO UPDATE` is deliberately avoided: PowerSync exposes synced tables as SQLite _views_, and SQLite forbids upserts against a view ("cannot UPSERT a view").
- **Cross-device propagation (synced tables only).** Rows are queued in PowerSync's CRUD log and fanned out to every other signed-in device, so restoring an old backup overwrites newer rows everywhere they share an ID. **Local-only tables stay local**: `models_secrets`, `mcp_secrets`, and `agents_secrets` never upload, so a different device gets the configs that need keys but not the keys. The confirm dialog states the overwrite and the fan-out.
- **`userId` re-stamped from the session.** On synced tables the row's `userId` is overwritten with the signed-in user's id; the file's value is never trusted. Local-only secret tables have no `user_id` column. The backend's upload route enforces the same invariant from the JWT (`backend/src/dal/powersync.ts`).
- **Soft-deleted rows preserved.** `deletedAt` rides through verbatim.
- **Credentials keep their destination.** Each model key and MCP credential is bound to the endpoint it was saved for (`models_secrets.provider`/`url`, `approvedUrl` in the `mcp_secrets` blob), and reads return it only while the parent row still points there. A file that gives an existing model or server a new URL but omits its secret therefore leaves the local credential unused. A secret row in the file replaces the local row outright rather than merging into it, so a partial row can't keep a local key under a destination the file picked. Secret rows from an older backup are bound to the URL their parent has after the restore, and a file that only re-spells a URL keeps the local key.
- **Atomic.** One `db.transaction`; any row-level failure rolls back every preceding write.
- **Forward-compatible at the table level only.** Unrecognized table keys land in `ignoredTableNames` and are skipped. Columns are **not**: Drizzle builds the SQL column list from each row's keys, so an unknown column raises `no column named …` and rolls back. Future schemaVersions adding columns must bump the version (v1 then rejects the file outright) or strip unknown keys.
- **No cross-table consistency check.** The synced schema has no real FK constraints (per `multi-device-sync.md`), so there is no insertion order: a `chat_messages` row referencing a missing `chat_threads.id` is inserted as an orphan.

### Account-mismatch guard

No DB write happens until the user confirms, and the dialog is built from a read-only preview. `summarizeExportEnvelope` ([`src/dal/import.ts`](../../../src/dal/import.ts)) re-checks the envelope shape and returns the total row count, the formatted `exportedAt`, and the exporting user's email; `src/settings/preferences.tsx` calls it as soon as the file is picked. When both emails exist and differ (case-insensitively), it sets `accountMismatch`. For a full backup the dialog adds a destructive-styled warning; for a single-chat file it notes which account the chat came from (see [Single-chat files](#single-chat-files)).

Email rather than `user.id`, because Better Auth issues a new id when an account is deleted and recreated while the email stays stable. It stays `false` when either side is missing, so a legacy export without an email raises no false alarm. For a full backup the mistake is unrecoverable: the `userId` re-stamp makes foreign rows indistinguishable from the user's own. Not every foreign row syncs, though: see [Known limitations](#known-limitations-v1).

### Post-Workspaces follow-up

Once every user-content table carries a `workspaceId`, workspace handling stays deterministic and UI-free (no picker).

- **v1 files (no `workspaceId`):** rows are stamped with the default workspace's id on insert.
- **v2+ files (rows carry `workspaceId`):** preserved verbatim. If the workspace is missing locally, the importer creates it (or skips the row, TBD when v2 ships).

## Single-chat files

The chat menu's **Export** item (in the sidebar, on desktop and mobile) saves one chat as `thunderbolt-chat-<title>-YYYY-MM-DD.json` through `exportChatThread` ([`src/dal/export.ts`](../../../src/dal/export.ts)). The title is cut to 40 characters of letters (with their combining marks), digits, spaces, dots, dashes and underscores. The file is the v1 envelope with `"kind": "chat"` and two tables: the `chat_threads` row and every message the thread holds, edited-away branches included. Soft-deleted messages are left out, as the chat itself shows them. **Settings → Preferences → Data → Import Data** reads it back.

The file is meant to be shared, so it leaves out what a full backup keeps:

- the `userId` of every row (the importer stamps its own anyway);
- each MCP server URL in `metadata.mcpTools`, cut to its origin (a hosted server's path or query can hold a token; the origin still picks the tool icon), and the older `metadata.mcpServers` record;
- `metadata.debugTranscript`, the link to a debug capture.

It still names its exporter in `user` (id and email), because the importer needs them to tell its own chat from someone else's. Message content, tool calls and results, reasoning and cited sources are the conversation, so they stay.

**Detection.** `detectChatImport` ([`src/dal/chat-import.ts`](../../../src/dal/chat-import.ts)) needs exactly one thread, with every message belonging to it. An unmarked file (older, or hand-made) must hold nothing else. A full backup always has settings and model rows, so it is never taken for a chat. A file marked `kind: "chat"` may carry other tables, so a later format can add some.

**Only the chat is written.** Once a file is recognized as a chat, the import writes `chat_threads` and `chat_messages` and lists any other table in `ignoredTableNames`. The dialog says "one chat", so a file can't use it to change settings, models or servers on the side.

**Whose file it is.** `isSameAccount` ([`src/dal/import.ts`](../../../src/dal/import.ts)) ties the file to the importing account only on a positive match:

- **Emails, when both sides have one**, as in the account-mismatch guard above. A deleted and recreated account has a new id, but its old rows went with the deletion, so the original ids are free.
- **Otherwise equal, non-empty user ids.**
- **A signed-out side never matches.** Rows made while signed out are uploaded by whichever account signs in first, and their ids may already be owned.

The file states its own exporter, so this is a claim, not proof. A file that claims the importer's email keeps its own ids and shows no different-account note. It still writes only that chat, under ids it carries, so it can only overwrite messages whose ids its author already knows.

The preview and the import use the same answer, and the dialog shows one sentence: "updated" for the same account, "adds a copy" otherwise.

**Same account: ids kept.** The import writes the file's thread and messages over the local ones, and restores the chat if it was deleted. It is a merge: local messages the file lacks stay.

**Otherwise: ids re-keyed.** The backend resolves `chat_threads` and `chat_messages` uploads on `id` alone and only lets the owner update a row (`backend/src/dal/powersync.ts`). A chat that kept another account's ids would be stored locally and acknowledged on upload, but never stored on the server, so it would never reach the importing account's other devices.

- `rekeyChat` derives each new id from an owner key and the original id. The owner key is the importing user's id, or `device:<device id>` when signed out; the prefix keeps the two from ever colliding.
- Messages are listed in id order, and the app's ids are uuid v7, whose first half is the time. A new id keeps that first half and takes the rest from a UUID v5 of the owner key and the original id, so the copy keeps the original's order, before any message written later. An id that isn't a uuid v7 is replaced by the UUID v5 whole.
- `chatThreadId` and `parentId` follow, so the message tree survives.
- Importing the same file again under the same owner key gives the same ids, so it updates the copy. A different key makes another copy: importing while signed out and again after signing in, or again after signing out (which gives the device a new id).
- The thread drops `projectId` and `acpSessionId`, which point at the other account's data.
- A signed-out user importing their own export gets a copy too, for the reason above.

**Not carried.**

- Attachments are device-local and not in the file. The message still shows the file's name, as on any other device, but the file can't be opened.
- A quote part's `sourceMessageId` is not re-keyed.
- `agentId`, `triggeredBy` and message `modelId` are kept as they are. A chat whose agent this account doesn't have opens with the agent it would otherwise pick.

## Known limitations (v1)

- **Full backups from another account don't fully sync.** Only single-chat files are re-keyed. A full backup keeps its ids, and the backend resolves `chat_threads`, `chat_messages`, `projects` and `triggers` on `id` alone (`backend/src/db/powersync-schema.ts`). So those rows import on this device, but their uploads are acknowledged and dropped while the original account still owns the ids.

- **In-memory payload.** The whole export is built in memory before download; heavy users (~tens of thousands of messages) see slower exports. A streaming variant is a follow-up if files cross ~100 MB in practice.
- **Plaintext at rest.** No encryption-at-rest on the file; users should treat it like their account password.
- **No backup of E2E key material.** The Content Key lives in the device's keyring (see [`e2e-encryption.md`](e2e-encryption.md)). Importing on a different device requires the standard device-approval flow.

### Provider connections

`provider_connections` includes metadata for every connection. `provider_connection_secrets` exports only the user-entered `apiKey` and its routing binding for API-key connections. OAuth access/refresh tokens and authorization generations are excluded. Import restores provider metadata before validating API-key bindings, generates a fresh local credential generation, and ignores OAuth secret rows even when a file supplies them. OAuth connections must be signed in again on the importing device.
