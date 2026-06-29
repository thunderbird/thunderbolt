# Pre-Workspaces Attach Migration

One-shot data migration that bridges the pre-Workspaces v1 local state (an
un-namespaced auth token, an un-namespaced IndexedDB key store, and a
`thunderbolt-sync.db` SQLite file with no `workspace_id` columns) into the
Workspaces v1 layout (per-server namespaced keys, `server-<id>.db`, every
synced row stamped with `workspace_id`).

It runs at most once per device per server. The localStorage and IndexedDB
steps fire from `useAppInitialization` right after `activateServer()`; the
SQLite step fires from `runPostAuthBootstrap` between
`ensurePersonalWorkspace` and `reconcileDefaults`.

Implementation lives in `src/migrations/pre-workspaces-attach/`.

## Files

- `table-list.ts` — canonical list of legacy SQLite tables
  (`syncedLegacyTables`, `localLegacyTables`, `allLegacyTables`) + per-table
  `needsWorkspaceId` / `needsScope` stamping flags.
- `legacy-db-path.ts` — locates `thunderbolt-sync.db` (fallback
  `thunderbolt.db`) in OPFS, the only filesystem wa-sqlite reads from.
- `completion-flag.ts` — per-device localStorage flags.
  `pre_workspaces_attach_completed` is device-global (no serverId): once set,
  EVERY step of the migration short-circuits on subsequent boots regardless of
  which server the user signs into. Without it, a user with cloud accounts on
  server A and server B would re-import the device-global legacy
  `thunderbolt-sync.db` into both workspaces, bleeding A's rows into B.
  `pre_workspaces_attach_data_completed__<serverId>` lands the instant the
  destructive table-copy + `ps_crud` replacement succeed, so a partial-failure
  retry doesn't re-run the queue wipe and clobber interim writes.
  `pre_workspaces_attach_completed__<serverId>` lands after every step
  (including the api-key stamp); later boots for the SAME server short-circuit
  on it even when the global flag isn't yet set. localStorage rather than the
  synced `settings` table so the flags stay device-local and can't race a
  second device's first-time migration.

## Removal (once every active install has migrated)

1. Revert the three call sites:
   - `src/hooks/use-app-initialization.ts` — `migrateLocalStorageIfNeeded` /
     `migrateEncryptionKeysIfNeeded`.
   - `src/lib/post-auth-bootstrap.ts` — `runLocalDbMigration`.
   - `backend/src/powersync/upload-handlers/workspace-scoped.ts` — the
     `computePersonalWorkspaceId(ctx.userId)` fallback in `validate()`/`apply()`
     for PUTs with no `workspace_id`.
2. Delete `src/migrations/pre-workspaces-attach/`.
3. Delete this doc.
4. Optional housekeeping: delete the localStorage flags and the legacy
   `thunderbolt-sync.db` files via a one-off boot-time cleanup. Not required —
   both are harmless once the migration code is gone.
