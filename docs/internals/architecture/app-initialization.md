# App Initialization

`executeInitializationSteps`
([`src/hooks/use-app-initialization.ts`](../../../src/hooks/use-app-initialization.ts)) runs everything
between "the bundle finished evaluating" and "the app renders a chat", handing one `InitData` object
to [`src/app.tsx`](../../../src/app.tsx) at `src/app.tsx:298`.

## The steps, in execution order

| Label                         | What it does                                                                  | On failure                           |
| ----------------------------- | ----------------------------------------------------------------------------- | ------------------------------------ |
| `step0_fetch_config`          | Fire-and-forget `/config` fetch; hydrates the persisted `useConfigStore`      | Logged; nothing downstream awaits it |
| `step0_5_storage_check`       | `isIndexedDbAvailable()` probe (`src/lib/platform.ts:203`)                    | Fatal: `STORAGE_UNAVAILABLE`         |
| `step1_create_app_dir`        | `createAppDir()` (Tauri app dir, or OPFS on web)                              | Fatal: `APP_DIR_CREATION_FAILED`     |
| `step2_initialize_database`   | Opens the database and registers the singleton                                | Fatal: `DATABASE_INIT_FAILED`        |
| `step2b_db_ready`             | `select 1` against the fresh handle, bounded at `dbReadyTimeoutMs` (30 s)     | Fatal: `DATABASE_INIT_FAILED`        |
| `step2d_build_search_index`   | `createSearchIndex` (`src/search/fts-setup.ts:146`)                           | Logged, boot continues               |
| `step2c_returning_boot_probe` | `hasCurrentDefaultsVersions` (`src/dal/settings.ts:256`): fresh or returning? | n/a                                  |
| `step3_wait_for_initial_sync` | Awaits or skips PowerSync's priority-1 first sync                             | `waitForInitialSync` never rejects   |
| `step4_reconcile_defaults`    | `reconcileDefaults` (`src/lib/reconcile-defaults.ts`)                         | Fatal: `RECONCILE_DEFAULTS_FAILED`   |
| `step4b_run_data_migrations`  | `runDataMigrations` (`src/lib/data-migrations/index.ts:53`)                   | Swallowed per migration; never fatal |
| `step5_get_settings`          | Reads `experimental_feature_tasks` / `experimental_feature_voice`             | n/a                                  |
| `step6_create_http_client`    | `createAuthenticatedClient`; skipped when a client was injected (tests)       | Fatal: `HTTP_CLIENT_INIT_FAILED`     |
| `step7_initialize_tray`       | Tauri tray, in parallel with step 8; each wrapper swallows its own failure    | Logged; boots with no tray           |
| `step8_initialize_posthog`    | PostHog client                                                                | Logged; boots with a null client     |

Several steps sit where they do because moving them breaks something no test and no type will
catch, mostly multi-device convergence of default data.

- **Every step is wrapped in `time(label, fn)`**: logs `[init] <label>: <n>ms` and feeds the
  `app_init_timing` event ([TELEMETRY.md](../../../TELEMETRY.md#startup-performance-app_)). Labels
  become property names on that event, so renaming one breaks the existing dashboards.
- **The labels are historical, not an order**: `0, 0.5, 1, 2, 2b, 2d, 2c, 3, 4, 4b, 5, 6, 7+8`, with
  `2d` physically before `2c`. Read the file, not the numbers.
- **`step2b_db_ready` is a bounded `select 1`.** PowerSync defers its expensive ready gate (WASM
  compile, OPFS open, schema replace) to the first query, so absorbing it here keeps `step4`
  measuring reconcile rather than storage setup. The bound matters: a locked or unusable local
  database surfaces here and nowhere earlier (`createAppDir` returns the virtual path `app-data` on
  web without touching OPFS; the step-0.5 probe only opens IndexedDB), and an unbounded await hangs
  the spinner forever.
- **`trackEvent('app_init_timing')` fires after step 8**, where the PostHog client first exists
  (`src/hooks/use-app-initialization.ts:397-408`).

## Fresh boot vs returning boot

Step 3 is the pipeline's one user-visible cost: a fresh boot waits up to 10 s
(`initialSyncTimeoutMs`, `src/db/powersync/database.ts:48`) for PowerSync's first sync before
rendering. Step 2c picks the path.

### When does a boot skip the sync wait?

```ts
const canSkipSyncWait = bundleVersionsCurrent && getLocalSetting('syncEnabled')
```

1. **Bundle versions current**, per the probe below.
2. **Sync enabled.** Sync-disabled devices take the fresh path even though `waitForInitialSync`
   returns `'disabled'` instantly, because `'disabled'` sets `initialSyncCompleted: true`, the only
   thing that lets reconcile's gate apply bundle updates on a standalone device. Skipping would pin
   it `false` and freeze those users on their defaults.

On the fast path `resolveInitialSyncStep`
([`src/hooks/use-app-initialization.ts:60`](../../../src/hooks/use-app-initialization.ts)) still starts
`waitForInitialSync()` unawaited (updates land as they arrive) and returns
`initialSyncCompleted: false`, keeping reconcile's version gate
([AGENTS.md](../../../AGENTS.md#reconciled-defaults-and-version-bumps)) closed while cloud state is
unsynced: a populated local table plus an unknown marker is indistinguishable from "cloud holds
newer rows we haven't received".

### What the sync gate waits for

`waitForInitialSync` (`src/db/powersync/database.ts:483`) awaits
`waitForFirstSync({ priority: initialSyncPriority })`, `initialSyncPriority = 1`
(`src/db/powersync/database.ts:59`), mirroring the `user_essentials` bucket in
[`powersync-service/config/config.yaml`](../../../powersync-service/config/config.yaml): `settings`,
`models`, `model_profiles`, `devices`, `chat_threads`. Lower-priority buckets (`chat_messages`,
`tasks`, `skills`, ...) stream in after the app is interactive.

The coupling is by convention only: if the deployed sync rules stop declaring priorities, PowerSync
falls back to the global `hasSynced` and the gate quietly waits for everything.

`initial_sync_outcome` on the telemetry event is one of `synced`, `timed_out`, `failed`, `disabled`
(sync off locally, returns immediately), or `skipped_returning` (the fast path).

### Why the probe checks versions, not just "have we booted before?"

`hasCurrentDefaultsVersions` requires every `defaults_version.*` marker to exist **and**
meet-or-exceed the version reconcile would apply on this boot: the bundled constant for tasks,
skills and settings; for models, whichever source `pickModelsDefaults`
([`src/lib/pick-defaults.ts:35`](../../../src/lib/pick-defaults.ts)) picks (the cached OTA payload only
when it declares a strictly higher version than the bundle and clears its sanity guards, the bundle
otherwise). That value is computed once above step 2c and shared with step 4, so the two cannot
disagree.

A "marker exists" probe would be wrong: nothing re-runs `reconcileDefaults` when the background
`waitForInitialSync()` resolves, so a bump taken on the fast path is stranded until the client ships
_another_ bump. Any client upgrade that bumped a bundled version, and any fresh OTA models payload,
must take the slow path once.

### Invariant: a new reconciled table must join the probe

`versionMarkerKeys` (`src/lib/reconcile-defaults.ts:34`) lists the four markers; the
`defaultsTargets` map at `src/hooks/use-app-initialization.ts:300-305`, typed
`Record<VersionMarkerKey, number>`, must cover every one (a missing or typo'd key is a compile
error). Miss the probe and that table's version bumps strand on every returning device, silently.

Model profiles need no marker: they ride the models gate (`insertMissing: true`,
`canOverwrite: modelsGate.canOverwrite`), so bumping `defaultModelsVersion` covers them.

## Data migrations run after reconcile

`runDataMigrations` is step 4b, deliberately after step 4: migrations transform user content (the
end-to-end encrypted columns the server cannot read) and some check for collisions against rows
reconcile seeds, so running first would hide a newly-seeded default from the check.

Failures are caught and logged per migration, so one broken migration blocks neither the others nor
boot. Migrations must be idempotent and rerun next launch; the contract is at the top of
[`src/lib/data-migrations/index.ts`](../../../src/lib/data-migrations/index.ts).

## The search index

`step2d_build_search_index` builds the unified FTS5 index.

- **Before the data steps**: it only needs the raw SQLite handle.
- **Best-effort**: a failed build logs and boot continues with a stale or empty palette.
- **Skipped entirely** when `getPowerSyncInstance()` returns null (non-PowerSync backends, e.g.
  `bun-sqlite` under test).
- **Coupled to PowerSync's internal table layout**; that coupling and its failure mode are in
  [AGENTS.md](../../../AGENTS.md#powersync-and-synced-tables).

## Failure modes and the error screens

Fatal steps return `{ success: false, error }` rather than throwing, and the hook turns that into
`initError`. An unguarded throw (PowerSync's deferred storage open is the usual suspect) hits the
hook's outer `try` and becomes `UNKNOWN_ERROR`, showing an error screen rather than a spinner that
never resolves.

`src/app.tsx:343-356` routes the result:

- `STORAGE_UNAVAILABLE` → `StorageUnavailableScreen`, which explains private windows and iOS Lockdown
  Mode, neither fixable by clearing data
- every other code → `AppErrorScreen`
- a missing `initData` or PowerSync instance → `<Loading />`

`AppErrorScreen` offers "Clear Local Database" only for `MIGRATION_FAILED` and
`DATABASE_INIT_FAILED` (`src/components/app-error-screen.tsx:48`); every other code gets
contact-support alone. That affordance is attached to the code, which is why both storage failures
above report `DATABASE_INIT_FAILED` rather than something more precise. Clearing calls `resetAppDir`
(`src/lib/fs.ts:89`): disconnect PowerSync, wipe OPFS, rerun the pipeline.

`HandleErrorCode` (`src/types/handle-errors.ts:5-17`) is shared with non-init code paths, so not
every value can reach the init error screen:

| Code                        | Raised by                                                            |
| --------------------------- | -------------------------------------------------------------------- |
| `STORAGE_UNAVAILABLE`       | Step 0.5 (fatal)                                                     |
| `APP_DIR_CREATION_FAILED`   | Step 1 (fatal)                                                       |
| `DATABASE_INIT_FAILED`      | Steps 2 and 2b (fatal)                                               |
| `RECONCILE_DEFAULTS_FAILED` | Step 4 (fatal)                                                       |
| `HTTP_CLIENT_INIT_FAILED`   | Step 6 (fatal)                                                       |
| `UNKNOWN_ERROR`             | The hook's outer catch (fatal)                                       |
| `TRAY_INIT_FAILED`          | Step 7; tracked only, boot continues                                 |
| `POSTHOG_FETCH_FAILED`      | `src/lib/posthog.tsx:152`; not an init failure                       |
| `SYNC_ENABLE_FAILED`        | `src/contexts/sign-in-modal-context.tsx:85`; post-sign-in            |
| `CANARY_EXTRACTION_FAILED`  | `src/services/encryption.ts:228`; device revocation                  |
| `MIGRATION_FAILED`          | Nothing today; still special-cased by the error screen and Storybook |
| `DATABASE_PATH_FAILED`      | Nothing today                                                        |

## Timing and telemetry

`src/lib/init-timing.ts` is the dependency-free collector: `src/index.tsx` calls
`markBundleEvaluated()` at module-eval time without pulling anything into the entry path, `App`
calls `markAppMounted()` from a `useState` lazy initializer, and `beginInitRun()` clears per-step
durations per run so a retry reports its own timings with an incremented `init_run`.

Per-step properties are generated from the `time('…')` call sites, so adding a step adds a property
automatically, but the full list in [TELEMETRY.md](../../../TELEMETRY.md#startup-performance-app_)
needs updating by hand.

## Where the code lives

| File                                                                                              | Role                                                                    |
| ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| [`src/hooks/use-app-initialization.ts`](../../../src/hooks/use-app-initialization.ts)             | The pipeline, the hook, `retry` and `clearDatabase`                     |
| [`src/app.tsx`](../../../src/app.tsx)                                                             | Consumes `InitData`, routes errors, mounts providers                    |
| [`src/lib/init-timing.ts`](../../../src/lib/init-timing.ts)                                       | Timing marks and the telemetry payload                                  |
| [`src/lib/pick-defaults.ts`](../../../src/lib/pick-defaults.ts)                                   | Bundled-vs-OTA models choice shared by the probe and reconcile          |
| [`src/lib/reconcile-defaults.ts`](../../../src/lib/reconcile-defaults.ts)                         | Version markers and the reconcile gate                                  |
| [`src/dal/settings.ts`](../../../src/dal/settings.ts)                                             | `hasCurrentDefaultsVersions`, the returning-boot probe                  |
| [`src/db/powersync/database.ts`](../../../src/db/powersync/database.ts)                           | `waitForInitialSync`, the priority-1 gate, the 10 s timeout             |
| [`src/lib/data-migrations/index.ts`](../../../src/lib/data-migrations/index.ts)                   | Migration registry and per-migration contract                           |
| [`src/types/handle-errors.ts`](../../../src/types/handle-errors.ts)                               | `HandleErrorCode`, `HandleError`, `HandleResult`                        |
| [`src/hooks/use-app-initialization.test.tsx`](../../../src/hooks/use-app-initialization.test.tsx) | Both `resolveInitialSyncStep` branches, `waitForDatabaseReady`, timings |
