# PR #371 Conflict Resolution Plan — PowerSync Rebase

## What Changed on Main

PR #383 (THU-191: PowerSync Pre-release) fundamentally changed how the database works:

1. **Migration system deleted entirely** — `src/drizzle/` folder gone (all SQL migrations, snapshots, `_migrations.ts`, journal). `src/db/migrate.ts` and `src/db/bundle-migrations.ts` deleted.
2. **Replaced by schema-at-init** — `src/db/apply-schema.ts` reads Drizzle table definitions and creates tables directly via `CREATE TABLE IF NOT EXISTS`. PowerSync applies schema on connection; tests use `applySchema()`.
3. **All `deletedAt` columns changed from `integer` to `text`** — now stores ISO 8601 strings (`new Date().toISOString()`) instead of unix timestamps (`Date.now()`). New utility `nowIso()` in `lib/utils.ts`.
4. **All `.notNull()`, `.unique()`, and `.references()` removed from table definitions** — PowerSync manages schema independently; FKs and constraints are incompatible with the sync model.
5. **`userId` column added to every table** — required by PowerSync sync rules for data scoping.
6. **`clearNullableColumns()` now skips `userId`** — the userId field must be preserved during soft-delete scrubbing.
7. **`DatabaseSingleton.reset()` is now `async`** — because PowerSync needs `disconnectAndClear()`.
8. **`settingsTable` PK renamed from `key` to `id`** — PowerSync requires all tables to have an `id` PK column. The Drizzle field is still accessed as `key` via `text('id').primaryKey()`.
9. **Vite config changed** — `bundle-migrations` plugin replaced with `copy-powersync-assets` plugin; `@powersync/web` added to `optimizeDeps.exclude`; `@shared` path alias added.

## Merge Conflicts (6 files)

| File | Conflict Type | Resolution |
|------|---------------|------------|
| `.gitignore` | Content — both branches added lines | Take main + keep our `evals/` addition |
| `src/dal/index.ts` | Content — both branches added exports | Take main's new exports + add our model-profiles exports |
| `src/types.ts` | Content — both branches modified type definitions | Take main's changes (chatThreadId required, Prompt/Trigger changes) + add our ModelProfileRow/ModelProfile |
| `src/drizzle/_migrations.ts` | Modify/delete — we modified, main deleted | **Delete our file.** Migrations no longer exist. |
| `src/drizzle/meta/_journal.json` | Modify/delete — we modified, main deleted | **Delete our file.** Migrations no longer exist. |
| `src/drizzle/0018_lucky_surge.sql` | Add on our branch, parent dir deleted on main | **Delete.** The migration SQL is no longer needed. `applySchema()` reads directly from table definitions. |

## Non-Conflict Changes Required

These files auto-merged but need manual corrections because of the new architecture:

### 1. `src/db/tables.ts` — `modelProfilesTable` must conform to PowerSync patterns

**Current (our branch):**
```typescript
export const modelProfilesTable = sqliteTable(
  'model_profiles',
  {
    modelId: text('model_id')
      .primaryKey()
      .notNull()
      .references(() => modelsTable.id, { onDelete: 'cascade', onUpdate: 'cascade' }),
    // ... columns with real(), integer() types ...
    deletedAt: integer('deleted_at'),
  },
)
```

**Must become:**
```typescript
export const modelProfilesTable = sqliteTable(
  'model_profiles',
  {
    // PowerSync requires 'id' as the PK column name in the DB.
    // Drizzle field name is 'modelId' for TypeScript access.
    modelId: text('id').primaryKey(),
    // ... same columns ...
    deletedAt: text('deleted_at'),        // text, not integer (ISO 8601)
    userId: text('user_id'),              // required for PowerSync sync
  },
)
```

Key changes:
- **Remove `.notNull()`** — PowerSync handles nullability
- **Remove `.references()`** — FKs removed for PowerSync compatibility
- **Rename PK column from `model_id` to `id`** — PowerSync requires `id` as the PK column name. The Drizzle field stays `modelId` via `text('id').primaryKey()` (same pattern as `settingsTable.key`)
- **Change `deletedAt` from `integer` to `text`** — ISO 8601 format
- **Add `userId: text('user_id')`** — required for PowerSync sync rules
- **Keep `real('temperature')`** — this is fine, SQLite supports REAL

### 2. `src/dal/model-profiles.ts` — Switch to ISO 8601 for deletedAt

**Current:** `deletedAt: Date.now()` (unix timestamp integer)
**Must become:** `deletedAt: nowIso()` (ISO 8601 string)

Import `nowIso` from `@/lib/utils`.

### 3. `src/defaults/model-profiles/` — Seed data needs `userId: null`

Every profile object needs `userId: null` added (same as all other default objects on main — see `defaultModelGptOss120b` in `defaults/models.ts`).

### 4. `src/defaults/model-profiles/index.ts` — Hash function must include `userId`

Wait — actually no. `userId` is not a user-editable field; it's set by PowerSync. The hash should NOT include `userId` (same reasoning as excluding `modelId` and `defaultHash`). But I need to verify what other hash functions do.

Looking at `hashModel()` in `defaults/models.ts`: it includes `deletedAt` but does NOT include `userId`. So our hash is correct — skip `userId`.

### 5. `src/lib/reconcile-defaults.ts` — Our additions auto-merged but must match main's version

Main added a skip-if-unchanged optimization:
```typescript
if (existing.defaultHash === defaultHashValue) {
  continue
}
```
Our additions (import `modelProfilesTable` + `defaultModelProfiles`, add reconciliation call) need to be applied on top of main's version.

Actually, looking at the system reminders more carefully — **main removed the model_profiles reconciliation entirely** because we haven't merged yet. So our reconcile additions will need to be re-applied cleanly. The auto-merge should handle this since our additions are at different locations than main's changes.

### 6. PowerSync registration — NEW files to create/modify

Since `model_profiles` is a new synced table, we must also:

a. **`shared/powersync-tables.ts`** — Add `'model_profiles'` to `powersyncTableNames` array and `powersyncTableToQueryKeys`
b. **`src/db/powersync/schema.ts`** — Add `model_profiles: tables.modelProfilesTable` to `drizzleSchema`
c. **Backend** — This is out of scope for this PR (backend changes go through a separate process), but we should note it as a follow-up

Actually — **wait**. Is `model_profiles` really a synced table? Let me think about this.

Model profiles contain per-model tuning (temperature, nudge text, prompt overrides). These are:
- Seeded from code defaults
- Potentially user-customizable via a future settings UI
- Scoped to the app, not to a user account

If profiles sync across devices, a user's customizations on one device propagate to all devices — that's probably desirable. The alternative (local-only) would mean each device has independent tuning, which is confusing.

**Decision: YES, model_profiles should be a synced table.** It follows the same pattern as `models` and `modes` — seeded defaults that the user can customize, synced across devices.

### 7. `src/drizzle/0018_lucky_surge.sql` and `src/drizzle/meta/0018_snapshot.json` — DELETE

These files belong to the old migration system that no longer exists. Delete both.

### 8. `src/defaults/model-profiles.ts` — Barrel re-export file

This file re-exports from `./model-profiles/index`. It auto-merged cleanly. No changes needed.

### 9. `src/ai/fetch.ts` — Auto-merged cleanly

Main's version of fetch.ts doesn't have our profile changes (those are only on our branch). The auto-merge should work because main's changes to fetch.ts were minimal (removing `modeName` from the options type). But we need to verify our profile-loading code still works with the new types.

Actually, looking at main's version of fetch.ts: `modeName` was removed from the options type. Our branch adds it back for mode-aware inference. This needs careful handling — main may have moved mode detection elsewhere.

Wait, looking more carefully at the system reminders — main's `fetch.ts` DOES still have mode-related code. The `AiFetchStreamingResponseOptions` type lost `modeName` but gained detection via `modeSystemPrompt?.includes('SEARCH MODE')`. Our branch is more explicit with `modeName` as a parameter. We should keep our approach since it's cleaner.

### 10. `src/ai/step-logic.ts` — Auto-merged but main's version lost our changes

Main has its own version of step-logic without our `buildStepOverrides`, `inferenceDefaults`, or `getNudgeMessagesFromProfile`. Our additions were pure additions (appended to the file), so the auto-merge should preserve them.

BUT — main renamed `getNudgeMessages` to accept `modeName?: string` without vendor param. Our branch had already done this differently (`getNudgeMessagesFromProfile` with profile param). Need to verify the merged result is consistent.

### 11. `src/dal/models.test.ts` — Auto-merged but needs verification

Main changed `deletedAt` assertions from `Date.now()` to `nowIso()`. Our tests added cascade and auto-profile tests. The auto-merge should handle this since our tests are new `describe` blocks added at the end.

### 12. `src/ai/eval/runner.ts` — Uses `setupTestDatabase` which changed

The eval runner calls `setupTestDatabase()` which now uses `applySchema()` instead of `migrate()`. This should work transparently since `applySchema()` reads from `tables.ts` (which will include our `modelProfilesTable`).

---

## Execution Plan (ordered)

### Step 1: Rebase onto main
```bash
git rebase origin/main
```

### Step 2: Resolve conflicts in order

**For each conflict:**

1. **`.gitignore`** — Take main's content, ensure `evals/` line is present
2. **`src/drizzle/_migrations.ts`** — Delete file (`git rm`)
3. **`src/drizzle/meta/_journal.json`** — Delete file (`git rm`)
4. **`src/drizzle/0018_lucky_surge.sql`** — Delete file (`git rm`)
5. **`src/drizzle/meta/0018_snapshot.json`** — Delete file (`git rm`)
6. **`src/dal/index.ts`** — Take main's exports + add our model-profiles block
7. **`src/types.ts`** — Take main's type changes + add our `ModelProfileRow` and `ModelProfile`

### Step 3: Fix `modelProfilesTable` in `src/db/tables.ts`

Rewrite the table definition to match PowerSync patterns:
- PK column: `modelId: text('id').primaryKey()`
- Remove `.notNull()`, `.references()`
- Change `deletedAt` to `text('deleted_at')`
- Add `userId: text('user_id')`

### Step 4: Fix `src/dal/model-profiles.ts`

- Replace `Date.now()` with `nowIso()` in `deleteModelProfileForModel`
- Import `nowIso` from `../lib/utils`

### Step 5: Fix seed data

In all 3 profile files (`gpt-oss.ts`, `mistral.ts`, `sonnet.ts`) and `index.ts`:
- Add `userId: null` to each profile object

### Step 6: Register in PowerSync

- **`shared/powersync-tables.ts`**: Add `'model_profiles'` to `powersyncTableNames` and add query keys entry
- **`src/db/powersync/schema.ts`**: Add `model_profiles: tables.modelProfilesTable` to `drizzleSchema`

### Step 7: Fix test files

- `src/dal/model-profiles.test.ts` — Verify assertions work with ISO 8601 `deletedAt`
- `src/dal/models.test.ts` — Verify cascade tests work with new types
- `src/defaults/model-profiles.test.ts` — Verify hash tests still pass
- `src/ai/step-logic.test.ts` — Verify `buildStepOverrides` tests still pass

### Step 8: Verify

```bash
bun tsc --noEmit    # zero errors
bun test            # all tests pass
```

---

## Risk Assessment

| Risk | Severity | Mitigation |
|------|----------|------------|
| PK rename `model_id` → `id` breaks existing data | HIGH | No existing production data — this is a new table. Safe. |
| `userId` missing from profile causes sync failure | HIGH | Add `userId: null` to all seed data. Reconciliation handles it. |
| ISO 8601 vs unix timestamp in `deletedAt` | MED | Grep for all `Date.now()` usage in our code, replace with `nowIso()`. |
| `applySchema()` doesn't create partial indexes | LOW | `applySchema` skips `WHERE` clauses. Partial indexes are a query optimization, not correctness. Tests will work without them. |
| PowerSync schema registration missing | HIGH | Must add to `shared/powersync-tables.ts` and `src/db/powersync/schema.ts`. Without this, the table won't sync. |
| `vite.config.ts` conflict with PowerSync plugin | MED | Take main's config wholesale. Our eval-related change (`.evals` → `evals`) in `.gitignore` is separate. |

---

## Files Summary

| Action | File | What to Do |
|--------|------|------------|
| DELETE | `src/drizzle/0018_lucky_surge.sql` | Migration system gone |
| DELETE | `src/drizzle/meta/0018_snapshot.json` | Migration system gone |
| DELETE | `src/drizzle/_migrations.ts` | Migration system gone |
| DELETE | `src/drizzle/meta/_journal.json` | Migration system gone |
| CONFLICT RESOLVE | `.gitignore` | Merge both additions |
| CONFLICT RESOLVE | `src/dal/index.ts` | Main's exports + our model-profiles |
| CONFLICT RESOLVE | `src/types.ts` | Main's changes + our new types |
| MODIFY | `src/db/tables.ts` | Rewrite modelProfilesTable for PowerSync |
| MODIFY | `src/dal/model-profiles.ts` | `nowIso()` instead of `Date.now()` |
| MODIFY | `src/defaults/model-profiles/gpt-oss.ts` | Add `userId: null` |
| MODIFY | `src/defaults/model-profiles/mistral.ts` | Add `userId: null` |
| MODIFY | `src/defaults/model-profiles/sonnet.ts` | Add `userId: null` |
| MODIFY | `shared/powersync-tables.ts` | Register model_profiles |
| MODIFY | `src/db/powersync/schema.ts` | Register model_profiles |
| VERIFY | All test files | Run and fix if needed |
