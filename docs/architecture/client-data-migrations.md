# Client Data Migrations

Client data migrations are TypeScript functions in [src/lib/data-migrations/](../../src/lib/data-migrations/) that rewrite the _content_ of rows in the user's local SQLite database, on the device, on every app launch.

|            | Backend schema migrations                                           | Client data migrations                                    |
| ---------- | ------------------------------------------------------------------- | --------------------------------------------------------- |
| What it is | Drizzle SQL files under `backend/drizzle/`                          | TypeScript `run(db)` functions                            |
| Generated  | `bun db generate`                                                   | Hand-written                                              |
| Applied    | Against PostgreSQL                                                  | Against local SQLite, at every app launch                 |
| Changes    | The _shape_ of the database                                         | The _content_ of rows                                     |
| Gotcha     | `_journal.json` (see "Backend migrations checklist" in `AGENTS.md`) | No ledger; see [the four rules](#the-contract-four-rules) |

The local SQLite schema has no migration system. PowerSync creates the tables from `AppSchema` ([src/db/powersync/schema.ts](../../src/db/powersync/schema.ts)) at startup, and [src/db/apply-schema.ts](../../src/db/apply-schema.ts) does the equivalent for tests. Adding a column is free on the client; reshaping existing rows is not.

## The migrations that exist today

| Migration                             | Invoked from                                                | What it does                                                                                                                                                                                                                 |
| ------------------------------------- | ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `automations-to-skills`               | Registry                                                    | Converts each surviving `prompts` row into a `skills` row and soft-deletes the source, pinning migrated skills in id order until `maxPinnedSkills` fills. Rows it cannot convert stay put and count as `stranded` (THU-560). |
| `restamp-skill-default-hashes`        | Registry                                                    | Re-stamps `defaultHash` on skill rows written before `label` joined `hashSkill`, so reconciliation does not misread pristine rows as edited.                                                                                 |
| `restamp-widget-skill-default-hashes` | Registry, plus a direct call at `reconcile-defaults.ts:634` | Re-stamps widget-skill contracts from the old full-row hash to the content-only hash, so enabled/pinned state survives a contract update.                                                                                    |
| `upgradeModelDefaults`                | `reconcile-defaults.ts:536` only (not a `DataMigration`)    | Moves reused model ids past their legacy slugs, even on rows that user edits have locked out of normal reconciliation.                                                                                                       |

The registry is the `migrations` array at [src/lib/data-migrations/index.ts:42](../../src/lib/data-migrations/index.ts).

### Registry or direct call?

Register it, unless reconciliation needs the effect to have already happened. A migration called from inside reconcile ([src/lib/reconcile-defaults.ts](../../src/lib/reconcile-defaults.ts)) receives the reconcile transaction (`tx`) and must not open its own.

- `upgradeModelDefaults` runs inside that transaction after the models pass. Its `normalizeModelDefault` helper is mapped over the defaults payload before the transaction opens (`reconcile-defaults.ts:457`), because the normalized payload has to be the one reconcile compares against.
- `restampWidgetSkillDefaultHashes` runs immediately before the skills pass so a shipped full-row hash is recognized on the _same_ boot as the contract update superseding it. The registry's second invocation is an idempotent no-op.

Both rewrite the `defaultHash` that reconciliation reads as its "has the user edited this row" signal. Read [reconciled-defaults.md](./reconciled-defaults.md) and [composite-primary-keys-and-default-data.md](./composite-primary-keys-and-default-data.md) first.

## Why content migrations cannot run on the server

Under E2EE the columns carrying user content (`name`, `label`, `description`, `instruction`, `prompt`, `title` and siblings) are encrypted before leaving the device; the server holds ciphertext and no key. `encryptedColumnsMap` ([src/db/encryption/config.ts](../../src/db/encryption/config.ts)) is the authoritative list, rendered as a table in [e2e-encryption.md](./e2e-encryption.md#what-is-and-isnt-encrypted).

Backend SQL can rename or add a column, but cannot read a skill's instruction, slugify a title, or recompute a content hash. E2EE is opt-in and off by default; the design still has to hold for accounts that enable it, so content migrations always take the client path.

## The contract: four rules

A `DataMigration` ([src/lib/data-migrations/index.ts:36](../../src/lib/data-migrations/index.ts)) is a stable `id` (appears in logs and telemetry, never reused) plus a `run(db)`. The four rules in that file's JSDoc are load-bearing.

### Idempotent

There is no "has this run" ledger: every registered migration runs on every launch, forever, until someone deletes it. A second pass over already-migrated data must be a no-op, so the migration's own query has to be self-limiting.

- `restampSkillDefaultHashes` only touches rows whose stored hash still matches the frozen legacy formula, so a re-stamped row no longer qualifies.
- `automationsToSkills` selects `prompts` rows `WHERE deletedAt IS NULL` and soft-deletes each source as it goes, so a converged account selects nothing.

### Forward-compatible across devices

Two devices can run the same migration on the same input before either syncs the result. Deterministic ids make both produce the same primary key, so the backend's `ON CONFLICT` on `(id, user_id)` ([backend/src/dal/powersync.ts](../../backend/src/dal/powersync.ts)) settles the race instead of each device inserting a duplicate under a fresh UUID.

- `deriveSkillIdFromAutomationId` ([src/lib/data-migrations/derive-skill-id.ts](../../src/lib/data-migrations/derive-skill-id.ts)): SHA-256 over `migrated_automation:<id>`, formatted as a UUID, so no extra column remembers the source mapping.
- Ordering must be deterministic too: `automationsToSkills` sorts by id before assigning pin slots.

### Atomic per unit of work

Wrap the smallest meaningful unit (typically one source row to one destination row) in a Drizzle transaction, not the whole migration. PowerSync uploads each row independently, so the halves replicate separately cross-device regardless; the transaction only guarantees one device never observes half-written state.

### Self-deleting

Delete the file in a follow-up PR once telemetry shows the active population has upgraded past the release that introduced it. Leave a `DELETE ME` note naming the condition and the cleanup ticket, as the two `restamp-*` migrations do.

Pick a signal that covers failures: `automations-to-skills.ts` emits `automations_migration_run` with both `count` and `stranded`, because a user whose automation could not be migrated (slug collision, unslugifiable title) reports `count: 0` forever while their source row is still alive.

## Where it runs

`runDataMigrations` is step 4b of app initialization, [src/hooks/use-app-initialization.ts:356](../../src/hooks/use-app-initialization.ts). It runs _after_ `reconcileDefaults` (step 4) so newly-seeded defaults exist when a migration checks for collisions: `automationsToSkills` skips an automation whose slug is taken by an existing skill, and the seeded `daily-brief` skill has to be in the table for that check to be correct. The init timer reports its duration to PostHog as `step4b_run_data_migrations_ms` inside `app_init_timing` ([src/lib/init-timing.ts](../../src/lib/init-timing.ts)).

### What happens when a migration throws

The runner catches, logs, and continues ([src/lib/data-migrations/index.ts:53](../../src/lib/data-migrations/index.ts)). It never throws, so a broken migration cannot block boot or stop later ones.

A migration can therefore be partially applied (`automationsToSkills` also catches per-row, counting the failure as `stranded`) and the next launch retries. Only the idempotency rule makes that safe: a migration that is not a no-op on a second pass compounds its damage every launch.

## Testing

```
bun test src/lib/data-migrations --timeout 5000
```

Each migration has a colocated `.test.ts` driving a real SQLite database through `setupTestDatabase` / `resetTestDatabase` (`src/dal/test-utils`). Beyond the happy path: run the migration twice and assert the second pass changes nothing, and seed a user-edited row and assert it is left alone.

Where a migration freezes a historical hash formula, reproduce that formula in the test rather than importing it, so a change to the live formula cannot silently rewrite what the test considers "legacy". See `restamp-skill-default-hashes.test.ts`.
