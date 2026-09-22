# Reconciled Defaults

The models, model profiles, tasks, skills and settings the app ships with are not constants read at
render time. They are **rows in the user's database** — the same synced, user-editable, multi-device
SQLite tables that hold everything else. That choice is what makes a shipped default editable (rename a
model, disable a skill, tick a task) and what makes the edit follow the user to their other devices.

The cost is that shipping a _changed_ default means writing into a table the user also writes to, from
whichever device happens to boot first, while other devices hold their own copies and possibly an older
app build. `reconcileDefaults` ([`src/lib/reconcile-defaults.ts:453`](../../src/lib/reconcile-defaults.ts))
is the algorithm that does that without clobbering user edits and without two devices overwriting each
other forever. It runs once per boot, as step 4 of app initialization — see
[App Initialization](./app-initialization.md) for the surrounding pipeline and the returning-boot fast
path, and the "Reconciled defaults and version bumps" section of
[AGENTS.md](../../AGENTS.md#reconciled-defaults-and-version-bumps) for the short version of the rule you
need when changing a default.

Three signals decide every write:

1. **`default_hash`** on the row — does this row still look like the default we last wrote, or has the
   user edited it?
2. **The `defaults_version.*` marker** in `settings` — is our copy of the defaults newer than the newest
   copy ever applied to this account?
3. **`initialSyncCompleted`** — is our view of the account's state trustworthy yet?

## The five reconciled tables

| Table            | Version constant                                          | Hash                                                           | Key       | Notable options                                                                             |
| ---------------- | --------------------------------------------------------- | -------------------------------------------------------------- | --------- | ------------------------------------------------------------------------------------------- |
| `models`         | `defaultModelsVersion` (`shared/defaults/models.ts:175`)  | `hashModel` (`shared/defaults/models.ts:58`)                   | `id`      | `frozenFields: ['isConfidential', 'provider']`, `metadataFields: ['description', 'vendor']` |
| `model_profiles` | none — rides the models gate                              | `hashModelProfile` (`src/defaults/model-profiles/index.ts:20`) | `modelId` | `insertMissing: true`                                                                       |
| `tasks`          | `defaultTasksVersion` (`src/defaults/tasks.ts:70`)        | `hashTask` (`src/defaults/tasks.ts:13`)                        | `id`      | —                                                                                           |
| `skills`         | `defaultSkillsVersion` (`src/defaults/skills.ts:283`)     | `hashSkill` (`src/defaults/skills.ts:22`)                      | `id`      | `frozenFields: ['enabled', 'pinnedOrder']` for widget skills only                           |
| `settings`       | `defaultSettingsVersion` (`src/defaults/settings.ts:268`) | `hashSetting` (`src/defaults/settings.ts:14`)                  | `key`     | —                                                                                           |

`prompts` used to be on this list; skills superseded the default automations in THU-547 and reconcile no
longer touches it. Why these tables carry composite primary keys on the backend is covered in
[Composite Primary Keys and Default Data](./composite-primary-keys-and-default-data.md).

Reconcile also creates the `anonymous_id` setting when it is absent. Its value is generated at runtime
rather than shipped, so the row is deliberately _not_ in `defaultSettings` and not reconciled —
`createSetting` inserts it only when missing and never overwrites an existing value.

## `default_hash`: the user-edit detector

Every hash function fingerprints **only the fields a user can edit**, and reconcile compares two
fingerprints: the hash recomputed from the stored row, and the `default_hash` column written the last time
reconcile touched it. Equal means untouched, so the row may be updated in place. Different means the user
edited it, and reconcile leaves it alone permanently — a later version bump does not override a user edit.

- `hashValues` ([`shared/lib/hash.ts:16`](../../shared/lib/hash.ts)) is a **wire contract, not an
  implementation detail**. Stored hashes in user databases depend on its output byte for byte, and the
  frontend, backend and shared code all have to agree. Changing it invalidates every `default_hash` in the
  wild at once.
- Adding or removing a field from one of the hash functions has the same effect for that table: existing
  rows stop matching a fresh recomputation and read as "user-edited" forever. `hashModel` has been through
  this twice (`apiKey` removed, `supportsParallelToolCalls` added), which is why the retirement sweep below
  ignores the hash.
- `deletedAt` is inside the hash for models, profiles and non-widget skills: deleting one of those defaults
  _is_ a user configuration choice, and hashing it stops reconcile from resurrecting the row. `hashTask`
  covers only `item` and `isComplete`, so tasks lean on their delete path instead — `deleteTask` scrubs the
  row's nullable columns, `default_hash` among them, which fails the resurrect check below just as firmly.
- **Widget skills hash content only** — `hashSkill` excludes `enabled`, `pinnedOrder` and `deletedAt` for
  ids matching `isWidgetSkillId`, because a widget's instruction text is a locked contract that must be
  updatable even on a widget the user turned off. Their `enabled`/`pinnedOrder` are protected by
  `frozenFields` instead, which preserves the user's state while still writing the new contract.
- A **null** `default_hash` means user-created. That is what exempts user rows from retirement, and reconcile
  bootstraps a missing hash on a row it recognizes so modification tracking starts working.
- **`metadataFields` sit outside the hash.** `description` and `vendor` on a model are server-owned copy, not
  user-editable, so `hashModel` ignores them — but reconcile compares them explicitly and updates when they
  drift. `shared/defaults/models.test.ts` hashes them separately for the same reason, so a metadata-only
  change still trips the snapshot and gets its version bump.

## The version gate: who is allowed to write

Each reconciled table that carries its own version constant records the highest defaults version ever
applied to this account under a `defaults_version.*` key in `settings` — four keys, one each for models,
tasks, skills and settings (`versionMarkerKeys`,
[`src/lib/reconcile-defaults.ts:34`](../../src/lib/reconcile-defaults.ts)); profiles have none, because they
ride the models gate. Because the markers are settings rows, they sync — which is the whole point. They are
the ordering signal that stops two devices on different builds from taking turns rewriting the same rows
(THU-637, extended from models-only to every reconciled table in THU-677).

`computeCanOverwrite` (`src/lib/reconcile-defaults.ts:86`) collapses two concerns into one boolean:

```ts
const rawCanOverwrite = pickedVersion > (stored.version ?? Number.NEGATIVE_INFINITY)
const canOverwrite = rawCanOverwrite && (!hasAnyRow || initialSyncCompleted)
```

The first clause is version ordering: only a strictly newer defaults source may overwrite. The second is
pessimism about unsynced state — when the table already has rows and the initial sync has not completed, a
missing marker cannot be told apart from a marker that has not arrived yet, so writing would risk
downgrading rows a newer peer already shipped. A fresh install with zero rows bypasses it, which is how the
app seeds defaults offline.

The four `hasAnyRow` probes — one per marker — are read **once, up front, before any write in the
transaction**. Probing per table would poison the settings probe: earlier tables advance their version
markers into `settings`, so by the time the settings pass ran, the "empty settings table" signal would be
gone.

### Three switches, not one

`reconcileDefaultsForTable` (`src/lib/reconcile-defaults.ts:199`) takes authority as three separate options
because they answer different questions. The latter two default to `canOverwrite` for callers that have no
reason to split them.

- **`canOverwrite`** — "is our content authoritative?" Gates updates to existing rows.
- **`insertMissing`** — "must this row exist regardless?" Only `model_profiles` sets it true: profiles are
  1:1 with models, and a model without its profile is a runtime hazard, whereas a briefly-stale profile
  self-heals on the next sync. Everything else keeps ghost-insert protection, so a closed gate means no new
  rows.
- **`canResurrect`** — "is our view of cloud state trustworthy?" Tracks `initialSyncCompleted` rather than
  `canOverwrite`, so an older-bundle-but-fully-synced device can still undo a mistaken soft-delete, while a
  mid-sync device stays non-mutating. Resurrection is narrow by construction: it fires only when the row is
  soft-deleted _and_ `hashFn({ ...existing, deletedAt: null })` still equals its stored hash. Cleanup only
  ever writes `deletedAt`, whereas the user-initiated delete paths scrub the row as well: `deleteModel`
  ([`src/dal/models.ts:194`](../../src/dal/models.ts)) nulls every nullable column, `default_hash` among
  them, via `clearNullableColumns` ([`src/lib/utils.ts:284`](../../src/lib/utils.ts)) — and `softDeleteSkill`
  ([`src/dal/skills.ts:220`](../../src/dal/skills.ts)) wipes the skill's content fields, which moves the
  recomputed hash. Either way, only a cleanup-shaped delete passes that check.

### `frozenFields`: columns reconcile may never change

Listed fields keep the existing row's value when reconcile updates it, and the stored hash reflects that
post-freeze state so future passes still recognize the row as unedited. It protects columns whose value
established a contract elsewhere:

- **`isConfidential`** on a model — a thread binds `isEncrypted` to it at creation
  ([`src/dal/chat-threads.ts:70`](../../src/dal/chat-threads.ts)) and sending throws if the two ever disagree
  ([`src/chats/chat-instance.ts:1083`](../../src/chats/chat-instance.ts)). Flipping it on a live row would
  strand every thread bound to that id.
- **`provider`** on a model — it routes inference. Flipping it under an existing id misroutes silently.
- **`enabled` and `pinnedOrder`** on widget skills — the counterpart to their content-only hash: the contract
  text updates, the user's on/off and pin state does not.

**To change a frozen field on a model, ship the new value under a fresh model id.** Freezing applies to
updates only; inserts use the default as-is.

### When the marker advances

A pass reports two things: `mutated` (something was written) and `everyBundleRowAtTarget` (every shipped id
ended the pass either matching the effective target hash, or in the settings-only `wouldOverwriteUserValue`
branch). The marker advances when `canOverwrite` holds **and** the pass either mutated or verified every row
at target. On the models path the models and profiles passes are coupled into one decision — either pass
mutating, or both passes at target, satisfies the clause (`src/lib/reconcile-defaults.ts:589`), so a
user-edited model profile does not strand the models marker.

Both halves are load-bearing. The mutation clause covers the ordinary version bump. The at-target clause
covers the existing-user upgrade, where rows already hash to the current bundle and reconcile legitimately
writes nothing but the marker still has to move — otherwise the returning-boot probe
(`hasCurrentDefaultsVersions`, [`src/dal/settings.ts:256`](../../src/dal/settings.ts)) never passes and those
devices sit on the slow sync-wait path indefinitely. And the case where _neither_ holds — every row
user-edited — must refuse, because stamping the marker would tell fresh-install peers that this version was
applied and stop them seeding their own rows.

`wouldOverwriteUserValue` is the settings-specific half of this. Settings the user owns (`preferred_name`,
`location_*`, the unit settings, `language`) ship with a **null** value rather than being omitted from
`defaultSettings`, and that null is load-bearing: a row whose stored value is non-null against a null default
is at its intended target, because "user-owned" _is_ the target for those keys. Reconcile skips it and still
counts it as at-target. Seeding code writes those rows with `recomputeHash` so this branch recognizes them
(see the units section of [AGENTS.md](../../AGENTS.md#units-and-their-defaults)).

The models path adds a third condition, `droppedOtaModelIds.length === 0` — see the OTA channel below.

## Retirement: `cleanupRemovedDefaults`

`cleanupRemovedDefaults` (`src/lib/reconcile-defaults.ts:392`) runs before the models pass and soft-deletes
any system model row (`isSystem === 1`, non-null `default_hash`) whose id is no longer in the current defaults
set, then sweeps profiles whose parent model is no longer alive. User-created rows are exempt via the null-hash
check.

The sweep is **unconditional on hash match** — retired ids are removed even from rows that read as user-edited.
That is the deliberate consequence of the hash-field-list drift described above: under a "keep edited rows"
rule, retired system models stayed stuck on user devices forever because their stored hash no longer matched a
fresh recomputation. The trade-off is that a user who genuinely customized a retired system model loses those
tweaks, which is acceptable because backend routing for a retired default is not guaranteed to survive anyway.

Two independent gates: the model scan needs `canOverwrite` (without it we cannot tell an unrecognized row from
a future default we do not know about yet), and the profile scan needs `initialSyncCompleted`, because it
trusts a locally-derived set of alive model ids that a partial sync would make wrong.

## The OTA channel (models only)

Models have a second defaults source. `GET /config` ships the backend's own copy of the shared defaults as
`defaults.models` — `{ version, defaultModelId, data }` at
[`backend/src/api/config.ts:30`](../../backend/src/api/config.ts) — and
the client caches the whole config in a `persist`-backed zustand store
([`src/api/config-store.ts:47`](../../src/api/config-store.ts)), so later boots read the last-known payload
synchronously. Since both sides import from `shared/defaults/models.ts`, a backend deploy can carry newer
defaults than a client build, and that is the point: it lets a defaults change reach users without a client
release. Only `version` and `data` are consumed; nothing reads `defaultModelId` from the payload today.

`pickModelsDefaults` ([`src/lib/pick-defaults.ts:35`](../../src/lib/pick-defaults.ts)) picks between server and
bundle by declared version, subject to three guards. Trip any one and the bundle wins:

1. `version` is finite and **strictly** higher than `defaultModelsVersion`.
2. `data` is a non-empty array.
3. **At least one id in `data` overlaps the bundled `defaultModels`.**

The third guard is the interesting one. A fully disjoint payload would look like a legitimate wholesale
replacement, and adopting it would be destructive in both directions at once: `cleanupRemovedDefaults` would
see none of the bundle-known ids in the new set and soft-delete the lot, while the reconcile pass would insert
nothing, because OTA-only ids have no bundled profile to pair with. The bundle is the floor — OTA can update or
retire ids the bundle knows, not replace the lineup.

Rollback is monotonic for the same reason the version gate exists: a server that _lowers_ its declared version
cannot overwrite. To retract a bad published set, ship a **higher** version carrying the reverted content.

Two more consequences of profiles not being part of the channel:

- Models in the OTA payload with no bundled profile are **filtered out of the reconcile pass** and logged.
  Inserting the model alone would break the 1:1 model↔profile invariant that `insertMissing: true` exists to
  protect. Cleanup still uses the unfiltered set, so an id the server ships and a newer-bundle peer already
  synced stays alive.
- When anything was filtered, the models marker does **not** advance. What this device applied is a strict
  subset of the picked version, and stamping the full version would lock a later, fuller-bundle client out of
  inserting the models this one could not. The visible cost is that the returning-boot fast path stays off on
  that device until a client build ships the matching profiles.

Reconcile receives the picked source through `ReconcileDefaultsOverrides`; the returning-boot probe is handed
the same value, so the two cannot disagree about what the boot targets.

## Changing a default

1. Edit the defaults file.
2. **Bump its version constant.** Without the bump nothing changes on any existing account — the gate
   requires strictly newer.
3. Update the colocated snapshot test — `shared/defaults/models.test.ts`, `src/defaults/skills.test.ts`,
   `src/defaults/tasks.test.ts`, `src/defaults/settings.test.ts`. It fails on any content change without a
   matching bump and prints what to update.

Model profiles have no version of their own — they ride `defaultModelsVersion`, so bumping models covers a
profile change too. They have no version snapshot either; `src/defaults/model-profiles.test.ts` asserts
instead that the profile set pairs 1:1 with the default model set, which is the bundle-side guard for the
invariant `insertMissing: true` enforces at runtime.

Two limits on what a bump buys you: frozen fields cannot be changed on an existing row at all (ship a new
id), and a bump never overrides a user edit — only rows that still hash to the previous default.

Adding another reconciled table with a version constant of its own means adding its marker to
`versionMarkerKeys` **and** to `defaultsTargets` in the init hook — the `Record<VersionMarkerKey, number>` type makes the second a compile error, but see
[App Initialization](./app-initialization.md#invariant-a-new-reconciled-table-must-join-the-probe) for why
missing it would otherwise strand every version bump on returning devices.

## Where the code lives

| File                                                                                                           | Role                                                                                   |
| -------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| [`src/lib/reconcile-defaults.ts`](../../src/lib/reconcile-defaults.ts)                                         | Version markers, the gate, the per-table pass, the retirement sweep                    |
| [`src/lib/pick-defaults.ts`](../../src/lib/pick-defaults.ts)                                                   | Bundled-vs-OTA choice and its three guards                                             |
| [`shared/lib/hash.ts`](../../shared/lib/hash.ts)                                                               | `hashValues` — the cross-boundary hash contract                                        |
| [`shared/defaults/models.ts`](../../shared/defaults/models.ts)                                                 | Shipped models, `hashModel`, `defaultModelsVersion` (shared with backend)              |
| [`src/defaults/`](../../src/defaults)                                                                          | Shipped tasks, skills, settings, model profiles and their hashes                       |
| [`src/dal/settings.ts`](../../src/dal/settings.ts)                                                             | `hasCurrentDefaultsVersions`, `updateSettings`'s `recomputeHash`                       |
| [`src/api/config-store.ts`](../../src/api/config-store.ts)                                                     | Persisted `/config` cache carrying the OTA payload                                     |
| [`backend/src/api/config.ts`](../../backend/src/api/config.ts)                                                 | The public `/config` endpoint that publishes it                                        |
| [`src/lib/data-migrations/upgrade-model-defaults.ts`](../../src/lib/data-migrations/upgrade-model-defaults.ts) | Model-id lineages: moves a reused id past legacy slugs even when edits block reconcile |
| [`src/lib/reconcile-defaults.test.ts`](../../src/lib/reconcile-defaults.test.ts)                               | Both version-gate suites, `everyBundleRowAtTarget`, widget skills, cleanup             |
| [`src/lib/pick-defaults.test.ts`](../../src/lib/pick-defaults.test.ts)                                         | One test per OTA guard, including the zero-overlap rejection                           |
