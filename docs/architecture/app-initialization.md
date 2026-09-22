# App Initialization

Everything between "the bundle finished evaluating" and "the app renders a chat" happens in one
function: `executeInitializationSteps` in
[`src/hooks/use-app-initialization.ts`](../../src/hooks/use-app-initialization.ts). It opens the
local database, decides whether to wait for sync, seeds and reconciles default data, runs data
migrations, and builds the HTTP client — then hands a single `InitData` object to
[`src/app.tsx`](../../src/app.tsx), which consumes it at `src/app.tsx:298` and mounts the provider
tree around it.

The ordering in that function is not incidental. Several steps are where they are because moving
them breaks something that no test and no type will catch — most of it multi-device convergence of
default data. This page records those reasons.

## The steps, in execution order

Each step is wrapped in `time(label, fn)`, which logs `[init] <label>: <n>ms` and records the
duration for the `app_init_timing` telemetry event (see
[TELEMETRY.md](../../TELEMETRY.md#startup-performance-app_)).

| Label                         | What it does                                                                   | On failure                           |
| ----------------------------- | ------------------------------------------------------------------------------ | ------------------------------------ |
| `step0_fetch_config`          | Fire-and-forget `/config` fetch; hydrates the persisted `useConfigStore`       | Logged; nothing downstream awaits it |
| `step0_5_storage_check`       | `isIndexedDbAvailable()` probe (`src/lib/platform.ts:203`)                     | Fatal — `STORAGE_UNAVAILABLE`        |
| `step1_create_app_dir`        | `createAppDir()` (Tauri app dir, or OPFS on web)                               | Fatal — `APP_DIR_CREATION_FAILED`    |
| `step2_initialize_database`   | Opens the database and registers the singleton                                 | Fatal — `DATABASE_INIT_FAILED`       |
| `step2b_db_ready`             | `select 1` against the fresh handle, bounded at `dbReadyTimeoutMs` (30 s)      | Fatal — `DATABASE_INIT_FAILED`       |
| `step2d_build_search_index`   | `createSearchIndex` (`src/search/fts-setup.ts:146`)                            | Logged, boot continues               |
| `step2c_returning_boot_probe` | `hasCurrentDefaultsVersions` (`src/dal/settings.ts:256`) — fresh or returning? | n/a                                  |
| `step3_wait_for_initial_sync` | Awaits or skips PowerSync's priority-1 first sync                              | `waitForInitialSync` never rejects   |
| `step4_reconcile_defaults`    | `reconcileDefaults` (`src/lib/reconcile-defaults.ts`)                          | Fatal — `RECONCILE_DEFAULTS_FAILED`  |
| `step4b_run_data_migrations`  | `runDataMigrations` (`src/lib/data-migrations/index.ts:53`)                    | Swallowed per migration; never fatal |
| `step5_get_settings`          | Reads `experimental_feature_tasks` / `experimental_feature_voice`              | n/a                                  |
| `step6_create_http_client`    | `createAuthenticatedClient`; skipped when a client was injected (tests)        | Fatal — `HTTP_CLIENT_INIT_FAILED`    |
| `step7_initialize_tray`       | Tauri tray, in parallel with step 8; each wrapper swallows its own failure     | Logged; boots with no tray           |
| `step8_initialize_posthog`    | PostHog client                                                                 | Logged; boots with a null client     |

**The labels are historical, not an order.** They were assigned as steps were inserted, so the
sequence reads `0, 0.5, 1, 2, 2b, 2d, 2c, 3, 4, 4b, 5, 6, 7+8` and `2d` physically precedes `2c`.
Read the file, not the numbers. The labels are load-bearing in one direction only: they become
property names on the telemetry event, so renaming one breaks the existing dashboards.

Two placements that are not obvious:

- **`step2b_db_ready` is a `select 1`.** PowerSync defers its expensive ready gate — WASM compile,
  OPFS open, schema replace — to the first query, so absorbing it here keeps `step4` measuring
  reconcile rather than storage setup. It is bounded because this is where a locked or unusable
  local database actually surfaces: `createAppDir` cannot catch it (on web it returns the virtual
  path `app-data` without touching OPFS) and the step-0.5 probe only opens IndexedDB. An unbounded
  await would leave the loading spinner up forever, which looks exactly like a slow network and
  hides the one remedy that works.
- **`trackEvent('app_init_timing')` fires after step 8**, because the PostHog client only exists
  from there on (`src/hooks/use-app-initialization.ts:397-408`).

## Fresh boot vs returning boot

Step 3 is the one user-visible cost in the pipeline: on a fresh boot the app waits up to 10 seconds
(`initialSyncTimeoutMs`, `src/db/powersync/database.ts:48`) for PowerSync's first sync before it
renders. A returning device that already holds the current defaults does not need that wait, so
step 2c decides which path this boot takes and step 3 acts on it.

### The sync gate is priority 1, not "all data"

`waitForInitialSync` (`src/db/powersync/database.ts:483`) waits on
`waitForFirstSync({ priority: initialSyncPriority })` with `initialSyncPriority = 1`
(`src/db/powersync/database.ts:59`). That mirrors the `user_essentials` bucket in
[`powersync-service/config/config.yaml`](../../powersync-service/config/config.yaml) — `settings`,
`models`, `model_profiles`, `devices`, `chat_threads`. Lower-priority buckets (`chat_messages`,
`tasks`, `skills`, …) stream in after the app is interactive. The constant and the bucket
definition are coupled by convention only: if the deployed sync rules stop declaring priorities,
PowerSync falls back to the global `hasSynced` and the gate quietly starts waiting for everything.

The outcome is one of `synced`, `timed_out`, `failed`, `disabled` (sync switched off locally, which
returns immediately), or `skipped_returning` — the last one being the fast path below. It is
reported as `initial_sync_outcome` on the telemetry event.

### The probe, and why it is stricter than "have we booted before?"

`hasCurrentDefaultsVersions` requires that every `defaults_version.*` marker exists **and**
meets-or-exceeds the version reconcile would apply on this boot: the bundled constant for tasks,
skills and settings, and for models whichever source `pickModelsDefaults`
([`src/lib/pick-defaults.ts:35`](../../src/lib/pick-defaults.ts)) picks — the cached OTA payload
only when it declares a strictly higher version than the bundle and clears its sanity guards, the
bundle otherwise. The picked models value is computed once above step 2c and passed to both the
probe and step 4, so the two can't disagree about what this boot targets.

A "marker exists" probe would be cheaper and wrong. Nothing re-runs `reconcileDefaults` when the
background `waitForInitialSync()` later resolves, so an outstanding bump taken on the fast path is
stranded forever — the client would have to ship _another_ bump to escape. Any client upgrade that
bumped a bundled version, and any fresh OTA models payload, therefore has to take the slow path
once so reconcile can apply it.

### Two escape hatches

```ts
const canSkipSyncWait = bundleVersionsCurrent && getLocalSetting('syncEnabled')
```

The fast path requires both conditions.

1. **Bundle versions current** — the probe above.
2. **Sync enabled.** Sync-disabled devices always take the fresh path, even though
   `waitForInitialSync` returns `'disabled'` instantly and costs nothing. The point is the return
   value: `'disabled'` sets `initialSyncCompleted: true`, which is what lets reconcile's gate apply
   bundle updates at all. It is the only way a standalone device ever picks up new defaults from a
   client upgrade. Taking the returning-boot skip there would pin `initialSyncCompleted: false` and
   freeze those users on their current defaults permanently.

On the fast path, `resolveInitialSyncStep`
([`src/hooks/use-app-initialization.ts:60`](../../src/hooks/use-app-initialization.ts)) still
starts `waitForInitialSync()` — unawaited, so the engine warms up and updates land as they arrive —
and returns `initialSyncCompleted: false` synchronously. That `false` is deliberate, not a
shortcut: reconcile's version gate must stay closed while cloud state is unsynced, because a
populated local table plus an unknown marker cannot be distinguished from "cloud holds newer rows
we haven't received". See the reconciled-defaults rules in
[AGENTS.md](../../AGENTS.md#reconciled-defaults-and-version-bumps) for the gate itself.

### Invariant: a new reconciled table must join the probe

`versionMarkerKeys` (`src/lib/reconcile-defaults.ts:34`) lists the four markers. The
`defaultsTargets` map at `src/hooks/use-app-initialization.ts:300-305` must cover every one of
them — the type is `Record<VersionMarkerKey, number>`, so a missing entry is a compile error and a
typo'd key is too. Adding a fifth reconciled table with its own version constant means adding it in
both places. Miss the probe and the table's version bumps get stranded on every returning device,
silently: no error, no failing test, just devices that never pick up the new defaults.

Model profiles are the exception that needs no marker — they ride the models gate
(`insertMissing: true`, `canOverwrite: modelsGate.canOverwrite`), so bumping `defaultModelsVersion`
covers them.

## Data migrations run after reconcile

`runDataMigrations` is step 4b, deliberately after step 4. Migrations transform _user content_ —
the columns the server cannot read because they are end-to-end encrypted — and some of them check
for collisions against rows that reconcile seeds, so running them first would make a
newly-seeded default invisible to the check. The runner catches each migration's failure
individually and logs it, so one broken migration neither blocks the others nor blocks boot; every
migration is required to be idempotent and runs again on the next launch. The contract each
migration signs up to is documented at the top of
[`src/lib/data-migrations/index.ts`](../../src/lib/data-migrations/index.ts).

## The search index

`step2d_build_search_index` builds the unified FTS5 index. It sits before the data steps because it
only needs the raw SQLite handle, and it is best-effort: a failed build logs and boot continues with
a stale or empty palette rather than an error screen. When `getPowerSyncInstance()` returns null
(non-PowerSync backends, e.g. `bun-sqlite` under test) the step is skipped entirely. The index
couples to PowerSync's internal table layout; that coupling and its failure mode are documented in
[AGENTS.md](../../AGENTS.md#powersync-and-synced-tables).

## Failure modes and the error screens

Fatal steps return `{ success: false, error }` rather than throwing, and the hook turns that into
`initError`. Anything that throws unguarded — PowerSync's deferred storage open is the usual
suspect — is caught by the hook's outer `try` and reported as `UNKNOWN_ERROR`, so an unexpected
throw produces an error screen rather than a spinner that never resolves.

`src/app.tsx:343-356` routes the result: `STORAGE_UNAVAILABLE` gets its own
`StorageUnavailableScreen` (it explains private windows and iOS Lockdown Mode, neither of which the
user can fix by clearing data), everything else gets `AppErrorScreen`, and a missing `initData` or
PowerSync instance renders `<Loading />`.

`AppErrorScreen` offers "Clear Local Database" only for `MIGRATION_FAILED` and
`DATABASE_INIT_FAILED` (`src/components/app-error-screen.tsx:48`); every other code gets the
contact-support button alone. That button is why both storage failures above are reported as
`DATABASE_INIT_FAILED` rather than a more precise code — the affordance is attached to the code.
Clearing calls `resetAppDir` (`src/lib/fs.ts:89`), which disconnects PowerSync and wipes OPFS, then
re-runs the whole pipeline.

`HandleErrorCode` (`src/types/handle-errors.ts:5-17`) is shared with non-init code paths, so not
every value can reach the init error screen:

| Code                        | Raised by                                                            |
| --------------------------- | -------------------------------------------------------------------- |
| `STORAGE_UNAVAILABLE`       | Step 0.5 — fatal                                                     |
| `APP_DIR_CREATION_FAILED`   | Step 1 — fatal                                                       |
| `DATABASE_INIT_FAILED`      | Steps 2 and 2b — fatal                                               |
| `RECONCILE_DEFAULTS_FAILED` | Step 4 — fatal                                                       |
| `HTTP_CLIENT_INIT_FAILED`   | Step 6 — fatal                                                       |
| `UNKNOWN_ERROR`             | The hook's outer catch — fatal                                       |
| `TRAY_INIT_FAILED`          | Step 7 — tracked only, boot continues                                |
| `POSTHOG_FETCH_FAILED`      | `src/lib/posthog.tsx:152` — not an init failure                      |
| `SYNC_ENABLE_FAILED`        | `src/contexts/sign-in-modal-context.tsx:85` — post-sign-in           |
| `CANARY_EXTRACTION_FAILED`  | `src/services/encryption.ts:228` — device revocation                 |
| `MIGRATION_FAILED`          | Nothing today; still special-cased by the error screen and Storybook |
| `DATABASE_PATH_FAILED`      | Nothing today                                                        |

## Timing and telemetry

`src/lib/init-timing.ts` is the collector. It is dependency-free so `src/index.tsx` can record
`markBundleEvaluated()` at module-eval time without pulling anything into the entry path; `App`
records `markAppMounted()` from a `useState` lazy initializer. `beginInitRun()` clears per-step
durations at the top of each run, so a retry after an error reports its own timings with an
incremented `init_run`. The event's full property list lives in
[TELEMETRY.md](../../TELEMETRY.md#startup-performance-app_) — note that the per-step properties are
generated from the `time('…')` call sites, so adding a step adds a property automatically and that
list needs updating by hand.

## Where the code lives

| File                                                                                           | Role                                                                    |
| ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| [`src/hooks/use-app-initialization.ts`](../../src/hooks/use-app-initialization.ts)             | The pipeline, the hook, `retry` and `clearDatabase`                     |
| [`src/app.tsx`](../../src/app.tsx)                                                             | Consumes `InitData`, routes errors, mounts providers                    |
| [`src/lib/init-timing.ts`](../../src/lib/init-timing.ts)                                       | Timing marks and the telemetry payload                                  |
| [`src/lib/pick-defaults.ts`](../../src/lib/pick-defaults.ts)                                   | Bundled-vs-OTA models choice shared by the probe and reconcile          |
| [`src/lib/reconcile-defaults.ts`](../../src/lib/reconcile-defaults.ts)                         | Version markers and the reconcile gate                                  |
| [`src/dal/settings.ts`](../../src/dal/settings.ts)                                             | `hasCurrentDefaultsVersions` — the returning-boot probe                 |
| [`src/db/powersync/database.ts`](../../src/db/powersync/database.ts)                           | `waitForInitialSync`, the priority-1 gate, the 10 s timeout             |
| [`src/lib/data-migrations/index.ts`](../../src/lib/data-migrations/index.ts)                   | Migration registry and per-migration contract                           |
| [`src/types/handle-errors.ts`](../../src/types/handle-errors.ts)                               | `HandleErrorCode`, `HandleError`, `HandleResult`                        |
| [`src/hooks/use-app-initialization.test.tsx`](../../src/hooks/use-app-initialization.test.tsx) | Both `resolveInitialSyncStep` branches, `waitForDatabaseReady`, timings |
