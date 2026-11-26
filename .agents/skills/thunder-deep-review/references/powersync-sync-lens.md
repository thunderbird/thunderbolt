# PowerSync lens (`powersync-sync-reviewer`)

The domain reviewer for synced-table changes: `shared/powersync-tables.ts`, the sync-rule configs, backend or frontend Drizzle schema, `backend/drizzle/**` migrations, a synced table's DAL/defaults/reconciliation, sync middleware and transformers, and account-deletion or device code. Mistakes here cause silent cross-device sync failure that passes local testing, so be strict and concrete.

## Load the source of truth first

Read these before reviewing; they change, so never review from memory:

- `docs/internals/architecture/powersync-account-devices.md`: synced-table requirements, adding a table, the PR flow, account deletion, devices.
- `docs/internals/architecture/powersync-sync-middleware.md`: sync transformation middleware, the custom SharedWorker, transformers.
- `docs/internals/architecture/e2e-encryption.md`: encrypted columns, key hierarchy, device approval.
- The PowerSync section of `AGENTS.md`.

## Scope

- Review only what the diff changed. Read the patch the dispatching skill supplied, then read source for context. Pre-existing issues are out of scope.
- Report findings with `file:line`, a severity (`blocker` / `warning` / `note`), and the documented rule each one violates.
- Read-only. End with a short PASS/CONCERNS verdict.

## Checklist

**1. Two-PR flow and ordering** (the top hazard)
- PR 1 is backend-only: backend Drizzle schema, the migration, `shared/powersync-tables.ts`, and the sync rules.
- PR 2 (frontend schema, DAL, defaults, reconciliation, UI/logic) merges only after PR 1's sync rules are live.
- **Blocker** when one PR mixes a new or changed sync rule or backend table with frontend schema/DAL for that table: shipping the frontend before the sync rules update causes silent sync failure.

**2. Migration journal integrity**
- Every new `backend/drizzle/*.sql` needs a matching snapshot in `backend/drizzle/meta/` and an entry in `backend/drizzle/meta/_journal.json`. Without the journal entry the migration never runs; cherry-picked migrations miss it most often.

**3. Sync-rule and schema parity**
- The table and its columns agree across the backend Drizzle schema, the frontend Drizzle schema (PR 2), `shared/powersync-tables.ts`, and all three sync-rule configs (`powersync-service/config/config.yaml`, `deploy/config/powersync-config.yaml`, `deploy/k8s/templates/configmaps.yaml`). Flag any column or table present in one and missing in another.
- Note for the reviewer: after PR 1 merges, the new `ghcr.io/thunderbird/thunderbolt/thunderbolt-powersync` image must be rolled onto the Render `powersync` service before PR 2 merges. CI rebuilds the image; the Render service does not auto-deploy.

**4. Encryption**
- A table carrying sensitive data has encrypted-column configuration matching `docs/internals/architecture/e2e-encryption.md`. Flag plaintext storage of data that should be end-to-end encrypted.

**5. Deletes**
- Synced tables soft-delete (`deletedAt`) and their queries filter soft-deleted rows.
- Account deletion and device removal still hard-delete this table's rows where required (the sanctioned hard-delete paths). Flag a new synced table that account deletion does not clean up.

**6. SharedWorker and the internal path**
- A `@powersync/web` bump keeps the `powersync-web-internal` alias in `vite.config.ts` (→ `@powersync/web/lib`) resolving, `ThunderboltSharedSyncImplementation` extending `SharedSyncImplementation`, and `@powersync/shared-internals` pinned to the exact version `@powersync/web` pins (one copy in `bun.lock`). These break without a TypeScript error.

**7. Sync-classification consistency (sibling tables and half-synced state)**

A wrong classification (synced when it should be local-only, or stuck half-way) fails as silently as a missing sync rule. For each table the diff adds or changes, compute its classification from the three registration points:
- (a) listed in `shared/powersync-tables.ts` (`powersyncTableNames`)
- (b) has a sync rule in `config.yaml`
- (c) the `localOnly` flag in `src/db/powersync/schema.ts`

A clean **SYNCED** table is (a) AND (b) AND NOT (c). A clean **LOCAL-ONLY** table is (c) AND NOT (a) AND NOT (b).

- **Blocker**: a table in a HALF state, present in some of {a, b, c} without forming a clean set. Examples: in `powersync-tables.ts` with no `config.yaml` rule; `localOnly: true` yet still listed in `powersync-tables.ts`; a `config.yaml` rule for a table the schema marks `localOnly`.
- **Warning**: a feature adds sibling tables (`x` + `x_secrets`, `x` + `x_members`, a config table + its data table) with different classifications and gives no reason. Ask: "is `x` meant to sync but `x_secrets` not, and is that intentional?" The local-only-secrets / synced-config split is the intended THU-504/505/506 pattern (secrets never cross the network; config replicates), so a split is often correct, but it must be deliberate.
- The LOCAL-ONLY contract holds in full (all four): `localOnly: true` in the schema; absent from `shared/powersync-tables.ts`; absent from `encryptedColumnsMap` in `src/db/encryption/config.ts`; primary-key column literally named `id`. Failing any one means the table is misclassified.
