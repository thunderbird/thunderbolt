# Reconciled Defaults

The models, model profiles, tasks, skills and settings the app ships with are **rows in the user's
database**, not render-time constants: they live in the same synced, user-editable SQLite tables as
everything else, so a shipped default is editable and the edit follows the user across devices.

`reconcileDefaults` ([`src/lib/reconcile-defaults.ts:453`](../../../src/lib/reconcile-defaults.ts))
writes a _changed_ default into those tables without clobbering user edits, and without two devices
on different builds overwriting each other forever. It runs once per boot, as step 4 of app
initialization.

Three signals decide every write:

| Signal                                        | Question                                                                             |
| --------------------------------------------- | ------------------------------------------------------------------------------------ |
| `default_hash` on the row                     | Does this row still look like the default we last wrote, or has the user edited it?  |
| The `defaults_version.*` marker in `settings` | Is our copy of the defaults newer than the newest copy ever applied to this account? |
| `initialSyncCompleted`                        | Is our view of the account's state trustworthy yet?                                  |

See also: [App Initialization](app-initialization.md) (surrounding pipeline, returning-boot fast
path) · [Composite Primary Keys and Default Data](composite-primary-keys-and-default-data.md)
(backend composite keys) · [AGENTS.md](../../../AGENTS.md#reconciled-defaults-and-version-bumps) (short
rule for changing a default).

## The five reconciled tables

| Table            | Version constant                                          | Hash                                                           | Key       | Notable options                                                                             |
| ---------------- | --------------------------------------------------------- | -------------------------------------------------------------- | --------- | ------------------------------------------------------------------------------------------- |
| `models`         | `defaultModelsVersion` (`shared/defaults/models.ts:175`)  | `hashModel` (`shared/defaults/models.ts:58`)                   | `id`      | `frozenFields: ['isConfidential', 'provider']`, `metadataFields: ['description', 'vendor']` |
| `model_profiles` | none (rides the models gate)                              | `hashModelProfile` (`src/defaults/model-profiles/index.ts:20`) | `modelId` | `insertMissing: true`                                                                       |
| `tasks`          | `defaultTasksVersion` (`src/defaults/tasks.ts:70`)        | `hashTask` (`src/defaults/tasks.ts:13`)                        | `id`      |                                                                                             |
| `skills`         | `defaultSkillsVersion` (`src/defaults/skills.ts:283`)     | `hashSkill` (`src/defaults/skills.ts:22`)                      | `id`      | `frozenFields: ['enabled', 'pinnedOrder']` for widget skills only                           |
| `settings`       | `defaultSettingsVersion` (`src/defaults/settings.ts:268`) | `hashSetting` (`src/defaults/settings.ts:14`)                  | `key`     |                                                                                             |

- `prompts` left the list in THU-547, when skills superseded the default automations.
- `anonymous_id` is created when absent but never reconciled: its value is generated at runtime, so
  the row is deliberately out of `defaultSettings`, and `createSetting` never overwrites.

## `default_hash`: the user-edit detector

Each hash fingerprints **only user-editable fields**. Reconcile recomputes it from the stored row and
compares against the `default_hash` column: equal means untouched and updatable in place, different
means user-edited and left alone permanently.

- **`hashValues` is a wire contract** ([`shared/lib/hash.ts:16`](../../../shared/lib/hash.ts)). Stored
  hashes depend on its output byte for byte across frontend, backend and shared code; changing it
  invalidates every `default_hash` in the wild.
- **Changing a hash's field list does the same for that table**: existing rows read as user-edited
  forever. `hashModel` has been through it twice (`apiKey` removed, `supportsParallelToolCalls`
  added), hence the retirement sweep ignoring the hash.
- **`deletedAt` is hashed for models, profiles and non-widget skills**, so deleting one of those
  defaults sticks. `hashTask` covers only `item` and `isComplete`; `deleteTask` scrubs the row's
  nullable columns including `default_hash`, which fails the resurrect check just as firmly.
- **Widget skills hash content only.** `hashSkill` excludes `enabled`, `pinnedOrder` and `deletedAt`
  for `isWidgetSkillId` ids: the instruction text is a locked contract that must update even on a
  widget the user turned off. `frozenFields` preserves their state instead.
- **A null `default_hash` means user-created**, exempting the row from retirement. Reconcile
  bootstraps a missing hash on a row it recognizes.
- **`metadataFields` sit outside the hash.** `description` and `vendor` are server-owned copy;
  reconcile compares them explicitly and updates on drift. `shared/defaults/models.test.ts` hashes
  them separately, so a metadata-only change still trips the snapshot.

## The version gate: who is allowed to write

Each table with a version constant records the highest defaults version ever applied to this account
under a `defaults_version.*` key in `settings`: four keys (models, tasks, skills, settings) in
`versionMarkerKeys` ([`src/lib/reconcile-defaults.ts:34`](../../../src/lib/reconcile-defaults.ts)).
Profiles have none. The markers are settings rows, so they sync; they are the ordering signal that
stops two devices on different builds taking turns rewriting the same rows (THU-637, extended to
every reconciled table in THU-677).

`computeCanOverwrite` (`src/lib/reconcile-defaults.ts:86`) collapses two concerns into one boolean:

```ts
const rawCanOverwrite = pickedVersion > (stored.version ?? Number.NEGATIVE_INFINITY)
const canOverwrite = rawCanOverwrite && (!hasAnyRow || initialSyncCompleted)
```

- **Version ordering:** only a strictly newer defaults source may overwrite.
- **Pessimism about unsynced state:** with rows present and the initial sync incomplete, a missing
  marker is indistinguishable from one still in flight, so writing could downgrade rows a newer peer
  already shipped. Zero rows bypasses it, which is how a fresh install seeds defaults offline.

All four `hasAnyRow` probes run **once, up front, before any write in the transaction**: earlier
tables write their markers into `settings`, so a per-table probe would poison the settings one.

### Three switches, not one

`reconcileDefaultsForTable` (`src/lib/reconcile-defaults.ts:199`) splits authority into three
options; the latter two default to `canOverwrite`.

| Option          | Question                                | Behaviour                        |
| --------------- | --------------------------------------- | -------------------------------- |
| `canOverwrite`  | Is our content authoritative?           | Gates updates to existing rows   |
| `insertMissing` | Must this row exist regardless?         | Bypasses ghost-insert protection |
| `canResurrect`  | Is our view of cloud state trustworthy? | Gates undoing a soft-delete      |

- **`insertMissing`:** `model_profiles` only. A model without its 1:1 profile is a runtime hazard,
  while a stale profile self-heals on the next sync. Everything else keeps ghost-insert protection,
  so a closed gate means no new rows.
- **`canResurrect`** tracks `initialSyncCompleted`, not `canOverwrite`, so an older-bundle-but-synced
  device can still undo a mistaken soft-delete while a mid-sync device stays non-mutating.
- Resurrection needs the row soft-deleted _and_ `hashFn({ ...existing, deletedAt: null })` still equal
  to its stored hash, so only a cleanup-shaped delete qualifies. Cleanup writes `deletedAt` alone;
  `deleteModel` ([`src/dal/models.ts:194`](../../../src/dal/models.ts)) nulls every nullable column via
  `clearNullableColumns` ([`src/lib/utils.ts:284`](../../../src/lib/utils.ts)) and `softDeleteSkill`
  ([`src/dal/skills.ts:220`](../../../src/dal/skills.ts)) wipes content fields.

### `frozenFields`: columns reconcile may never change

Listed fields keep the existing row's value on update, and the stored hash reflects that post-freeze
state so later passes still read the row as unedited.

| Field                    | Table         | Why frozen                                                                                                                                                                                                                                                                         |
| ------------------------ | ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `isConfidential`         | models        | A thread binds `isEncrypted` to it at creation ([`src/dal/chat-threads.ts:70`](../../../src/dal/chat-threads.ts)) and sending throws on disagreement ([`src/chats/chat-instance.ts:1083`](../../../src/chats/chat-instance.ts)); flipping it strands every thread bound to that id |
| `provider`               | models        | Routes inference; flipping it under an existing id misroutes silently                                                                                                                                                                                                              |
| `enabled`, `pinnedOrder` | widget skills | Counterpart to their content-only hash: the contract text updates, the user's on/off and pin state does not                                                                                                                                                                        |

**To change a frozen field on a model, ship a fresh model id.** Freezing applies to updates only;
inserts use the default as-is.

### When the marker advances

`canOverwrite` must hold **and** the pass must report `mutated` (something was written) or
`everyBundleRowAtTarget` (every shipped id matches the effective target hash, or took the
settings-only `wouldOverwriteUserValue` branch).

| Pass outcome                    | Marker   | Why                                                                                                                                                                                                  |
| ------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Mutated                         | advances | The ordinary version bump                                                                                                                                                                            |
| At target, nothing written      | advances | Existing-user upgrade; otherwise `hasCurrentDefaultsVersions` ([`src/dal/settings.ts:256`](../../../src/dal/settings.ts)) never passes and those devices sit on the slow sync-wait path indefinitely |
| Neither (every row user-edited) | refuses  | Stamping would tell fresh-install peers the version was applied and stop them seeding their own rows                                                                                                 |

Models and profiles share one decision: either pass mutating, or both at target, satisfies the clause
(`src/lib/reconcile-defaults.ts:589`), so a user-edited profile does not strand the models marker.
Models add a third condition, `droppedOtaModelIds.length === 0` (see OTA below).

`wouldOverwriteUserValue` is the settings half. User-owned keys (`preferred_name`, `location_*`, the
unit settings, `language`) ship a **null** value rather than being omitted from `defaultSettings`, and
that null is load-bearing: a non-null stored value against a null default is already at target, so
reconcile skips the row and still counts it at-target. Seeding code writes those rows with
`recomputeHash` so this branch recognizes them (see
[AGENTS.md](../../../AGENTS.md#units-and-their-defaults)).

## Retirement: `cleanupRemovedDefaults`

`cleanupRemovedDefaults` (`src/lib/reconcile-defaults.ts:392`) runs before the models pass. It
soft-deletes any system model row (`isSystem === 1`, non-null `default_hash`) whose id left the
defaults set, then sweeps profiles whose parent model is gone. User-created rows are exempt via the
null-hash check.

Two independent gates: the model scan needs `canOverwrite` (otherwise an unrecognized row is
indistinguishable from a future default), the profile scan needs `initialSyncCompleted` (it trusts a
locally-derived set of alive model ids that a partial sync would make wrong).

The sweep **ignores hash match**: retired ids go even from user-edited rows. Field-list drift had
already broken those hashes, so a "keep edited rows" rule left retired system models stuck on devices
forever. Customizations to a retired model are lost, which is acceptable: its backend routing is not
guaranteed to survive anyway.

## The OTA channel (models only)

`GET /config` ships the backend's own copy of the shared defaults as `defaults.models`,
`{ version, defaultModelId, data }` at
[`backend/src/api/config.ts:30`](../../../backend/src/api/config.ts). The client caches the whole config
in a `persist`-backed zustand store ([`src/api/config-store.ts:47`](../../../src/api/config-store.ts)),
so later boots read the last-known payload synchronously; only `version` and `data` are consumed, and
nothing reads `defaultModelId` today. Both sides import `shared/defaults/models.ts`, so a defaults
change can reach users on a backend deploy without a client release.

`pickModelsDefaults` ([`src/lib/pick-defaults.ts:35`](../../../src/lib/pick-defaults.ts)) takes the
server payload only if all three guards hold. Trip one and the bundle wins:

1. `version` is finite and **strictly** higher than `defaultModelsVersion`.
2. `data` is a non-empty array.
3. **At least one id in `data` overlaps the bundled `defaultModels`.**

Guard 3 blocks a disjoint payload passing as a wholesale replacement, destructive both ways:
`cleanupRemovedDefaults` would soft-delete every bundle-known id while the pass inserted nothing,
since OTA-only ids have no bundled profile. The bundle is the floor: OTA updates or retires ids the
bundle knows, it never replaces the lineup.

Rollback is monotonic: a server that _lowers_ its declared version cannot overwrite. Retract a bad
published set by shipping a **higher** version with reverted content.

Profiles are not on the channel, with two consequences:

- OTA models with no bundled profile are **filtered out of the reconcile pass** and logged; inserting
  the model alone breaks the 1:1 model↔profile invariant `insertMissing: true` protects. Cleanup uses
  the unfiltered set, so an id the server ships and a newer-bundle peer already synced stays alive.
- After any filtering the models marker does **not** advance: this device applied a strict subset, and
  stamping the full version would lock a later, fuller-bundle client out of inserting those models.
  The returning-boot fast path stays off there until a client build ships the matching profiles.

Reconcile receives the picked source through `ReconcileDefaultsOverrides`; the returning-boot probe
gets the same value, so the two cannot disagree.

## Changing a default

1. Edit the defaults file.
2. **Bump its version constant.** The gate requires strictly newer; without the bump nothing changes
   on any existing account.
3. Update the colocated snapshot test (`shared/defaults/models.test.ts`,
   `src/defaults/skills.test.ts`, `src/defaults/tasks.test.ts`, `src/defaults/settings.test.ts`). It
   fails on any content change without a matching bump and prints what to update.

A bump cannot change a frozen field on an existing row (ship a new id) and never overrides a user
edit, only rows that still hash to the previous default.

**Model profiles** ride `defaultModelsVersion`, so bumping models covers them. In place of a version
snapshot, `src/defaults/model-profiles.test.ts` asserts the profile set pairs 1:1 with the default
model set, the bundle-side guard for the invariant `insertMissing: true` enforces at runtime.

**Adding another reconciled table** with its own version constant means adding its marker to
`versionMarkerKeys` **and** to `defaultsTargets` in the init hook. `Record<VersionMarkerKey, number>`
makes the second a compile error; [App
Initialization](app-initialization.md#invariant-a-new-reconciled-table-must-join-the-probe) covers
why missing it would strand every version bump on returning devices.

## Where the code lives

| File                                                                                                              | Role                                                                                   |
| ----------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| [`src/lib/reconcile-defaults.ts`](../../../src/lib/reconcile-defaults.ts)                                         | Version markers, the gate, the per-table pass, the retirement sweep                    |
| [`src/lib/pick-defaults.ts`](../../../src/lib/pick-defaults.ts)                                                   | Bundled-vs-OTA choice and its three guards                                             |
| [`shared/lib/hash.ts`](../../../shared/lib/hash.ts)                                                               | `hashValues`, the cross-boundary hash contract                                         |
| [`shared/defaults/models.ts`](../../../shared/defaults/models.ts)                                                 | Shipped models, `hashModel`, `defaultModelsVersion` (shared with backend)              |
| [`src/defaults/`](../../../src/defaults)                                                                          | Shipped tasks, skills, settings, model profiles and their hashes                       |
| [`src/dal/settings.ts`](../../../src/dal/settings.ts)                                                             | `hasCurrentDefaultsVersions`, `updateSettings`'s `recomputeHash`                       |
| [`src/api/config-store.ts`](../../../src/api/config-store.ts)                                                     | Persisted `/config` cache carrying the OTA payload                                     |
| [`backend/src/api/config.ts`](../../../backend/src/api/config.ts)                                                 | The public `/config` endpoint that publishes it                                        |
| [`src/lib/data-migrations/upgrade-model-defaults.ts`](../../../src/lib/data-migrations/upgrade-model-defaults.ts) | Model-id lineages: moves a reused id past legacy slugs even when edits block reconcile |
| [`src/lib/reconcile-defaults.test.ts`](../../../src/lib/reconcile-defaults.test.ts)                               | Both version-gate suites, `everyBundleRowAtTarget`, widget skills, cleanup             |
| [`src/lib/pick-defaults.test.ts`](../../../src/lib/pick-defaults.test.ts)                                         | One test per OTA guard, including the zero-overlap rejection                           |
