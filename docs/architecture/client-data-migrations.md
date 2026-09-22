# Client Data Migrations

Thunderbolt has two migration systems, and they solve different problems.

- **Backend schema migrations** are Drizzle SQL files under `backend/drizzle/`, generated with `bun db generate` and applied against PostgreSQL. They change the shape of the database. See the "Backend migrations checklist" section of `AGENTS.md` for the `_journal.json` trap.
- **Client data migrations** are TypeScript functions in [src/lib/data-migrations/](../../src/lib/data-migrations/) that run on the user's device, against the local SQLite database, on every app launch. They change the _content_ of rows.

The local SQLite schema itself has no migration system at all. PowerSync creates the tables from `AppSchema` ([src/db/powersync/schema.ts](../../src/db/powersync/schema.ts)) at startup; [src/db/apply-schema.ts](../../src/db/apply-schema.ts) does the equivalent for tests. Adding a column is therefore free on the client. Reshaping the data in existing rows is not, and that is what this subsystem is for.

## Why content migrations cannot run on the server

On an E2EE-enabled deployment, the columns that carry user content — `name`, `label`, `description`, `instruction`, `prompt`, `title` and their siblings — are encrypted before they leave the device. `encryptedColumnsMap` ([src/db/encryption/config.ts](../../src/db/encryption/config.ts)) is the authoritative list; [e2e-encryption.md](./e2e-encryption.md#what-is-and-isnt-encrypted) renders it as a table. The server holds ciphertext and no key.

A backend SQL migration can rename a column or add one. It cannot read a skill's instruction, slugify a title, or recompute a content hash, because it cannot see any of those values. Anything that needs to understand content has to run on the device, per user, at init — which is exactly what `runDataMigrations` does.

E2EE is opt-in and off by default, but the design has to hold for the accounts that turn it on, so content migrations always take the client path.

## The contract

Every migration is a `DataMigration` ([src/lib/data-migrations/index.ts:36](../../src/lib/data-migrations/index.ts)): a stable `id` that appears in logs and telemetry and is never reused, plus a `run(db)`. The four rules in that file's JSDoc are load-bearing, and each exists for a reason a future author is likely to rediscover the hard way.

**Idempotent.** There is no "has this migration run" ledger. Every registered migration runs on every launch, forever, until someone deletes it. A second pass over already-migrated data must be a no-op. In practice this means the migration's own query has to be self-limiting: `restampSkillDefaultHashes` only touches rows whose stored hash still matches the frozen legacy formula, so once re-stamped a row no longer qualifies; `automationsToSkills` selects `prompts` rows `WHERE deletedAt IS NULL` and soft-deletes each source as it goes, so a converged account selects nothing.

**Forward-compatible across devices.** Two devices can run the same migration on the same input before either has synced the result. Use deterministic ids so both produce the same primary key and the backend's `ON CONFLICT` handling on `(id, user_id)` ([backend/src/dal/powersync.ts](../../backend/src/dal/powersync.ts)) settles the race, instead of two devices each inserting a duplicate under a fresh UUID. `deriveSkillIdFromAutomationId` ([src/lib/data-migrations/derive-skill-id.ts](../../src/lib/data-migrations/derive-skill-id.ts)) is the worked example: SHA-256 over `migrated_automation:<id>`, formatted as a UUID, so no extra column is needed to remember the source mapping. Ordering must be deterministic too — `automationsToSkills` sorts by id before assigning pin slots so both devices assign the same ones.

**Atomic per unit of work.** Wrap the smallest meaningful unit (typically one source row → one destination row) in a Drizzle transaction, not the whole migration. PowerSync uploads each row independently, so cross-device the two halves replicate separately regardless; the transaction only buys you a guarantee that a single device never observes half-written state.

**Self-deleting.** A migration is temporary code. Once telemetry shows the active population has upgraded past the release that introduced it, the file can be deleted in a follow-up PR. Leave a `DELETE ME` note naming the condition and the cleanup ticket, as `restamp-skill-default-hashes.ts` and `restamp-widget-skill-default-hashes.ts` do. `automations-to-skills.ts` records the sharper version of that: it emits an `automations_migration_run` event carrying both `count` and `stranded`, because a user whose automation could not be migrated (slug collision, unslugifiable title) reports `count: 0` forever while their source row is still alive — deleting the legacy table on a count-only signal would lose it.

## Where it runs

`runDataMigrations` is step 4b of app initialization, [src/hooks/use-app-initialization.ts:356](../../src/hooks/use-app-initialization.ts). It sits deliberately _after_ `reconcileDefaults` (step 4): newly-seeded defaults must already exist when a migration checks for collisions against them. `automationsToSkills` skips an automation whose slug is taken by an existing skill, and the seeded `daily-brief` skill has to be in the table for that check to be correct.

The step is wrapped in the init timer, so its duration reaches PostHog as `step4b_run_data_migrations_ms` inside the `app_init_timing` event ([src/lib/init-timing.ts](../../src/lib/init-timing.ts)).

### Failure policy

The runner catches each migration's error, logs it, and continues ([src/lib/data-migrations/index.ts:53](../../src/lib/data-migrations/index.ts)). It never throws, so a broken migration cannot block boot, and one failing migration does not prevent the ones after it from running. The consequence is that a migration can be partially applied — `automationsToSkills` also catches per-row, counting the failure as `stranded` — and the next launch simply tries again. This is only safe because of the idempotency rule above; a migration that is not a no-op on a second pass will compound its damage on every launch.

## Two invocation styles

Most migrations belong in the `migrations` array at [src/lib/data-migrations/index.ts:42](../../src/lib/data-migrations/index.ts), which today holds three entries:

| Migration                             | What it does                                                                                                                                                                                                                 |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `automations-to-skills`               | Converts each surviving `prompts` row into a `skills` row and soft-deletes the source, pinning migrated skills in id order until `maxPinnedSkills` fills. Rows it cannot convert stay put and count as `stranded` (THU-560). |
| `restamp-skill-default-hashes`        | Re-stamps `defaultHash` on skill rows written before `label` joined `hashSkill`, so reconciliation does not misread pristine rows as edited.                                                                                 |
| `restamp-widget-skill-default-hashes` | Re-stamps widget-skill contracts from the old full-row hash to the content-only hash, so enabled/pinned state survives a contract update.                                                                                    |

Two migrations are instead called directly from `reconcileDefaults` ([src/lib/reconcile-defaults.ts](../../src/lib/reconcile-defaults.ts)), because the post-reconcile slot is too late for them:

- `upgradeModelDefaults` runs inside the reconcile transaction immediately after the models pass (`reconcile-defaults.ts:536`), and its `normalizeModelDefault` helper is mapped over the defaults payload before that transaction opens (`reconcile-defaults.ts:457`). Reused model ids must move past their legacy slugs even on rows that user edits have locked out of normal reconciliation, and the normalized payload has to be the one reconcile compares against. Nothing calls it through the registry, so it is a plain exported function rather than a `DataMigration`.
- `restampWidgetSkillDefaultHashes` is invoked immediately before the skills pass (`reconcile-defaults.ts:634`) so that a shipped full-row hash is recognized on the _same_ boot as the contract update that supersedes it, rather than a boot later. It is still in the registry, where the second invocation is an idempotent no-op.

The rule of thumb: register it, unless reconciliation itself needs the migration's effect to have already happened. A migration called from inside reconcile receives the reconcile transaction (`tx`), so it must not open its own.

Because these migrations rewrite the `defaultHash` that reconciliation uses as its "has the user edited this row" signal, they are tightly coupled to the reconciled-defaults machinery. Read [reconciled-defaults.md](./reconciled-defaults.md) and [composite-primary-keys-and-default-data.md](./composite-primary-keys-and-default-data.md) before touching either.

## Testing

Each migration has a colocated `.test.ts` that drives a real SQLite database through `setupTestDatabase` / `resetTestDatabase` (`src/dal/test-utils`). Two cases are worth covering beyond the happy path: running the migration twice and asserting the second pass changes nothing, and seeding a user-edited row and asserting it is left alone. Where a migration freezes a historical hash formula, the test should reproduce that formula independently rather than importing it, so a change to the live formula cannot silently rewrite what the test considers "legacy" — see `restamp-skill-default-hashes.test.ts`.

Run them with `bun test src/lib/data-migrations --timeout 5000`.
