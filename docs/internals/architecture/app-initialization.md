# App Initialization

`executeInitializationSteps`
([`src/hooks/use-app-initialization.ts`](../../../src/hooks/use-app-initialization.ts)) opens local storage and prepares the data needed to mount the app. The hook publishes `InitData`
to [`src/app.tsx`](../../../src/app.tsx) once native window/tray setup has settled, then attaches
analytics after a rendering opportunity. Auth routing and chat hydration follow core initialization.

## The steps, in execution order

| Label                         | What it does                                                                  | On failure                           |
| ----------------------------- | ----------------------------------------------------------------------------- | ------------------------------------ |
| `step0_fetch_config`          | Fire-and-forget `/config` fetch; hydrates the persisted `useConfigStore`      | Logged; nothing downstream awaits it |
| `step0_5_storage_check`       | `isIndexedDbAvailable()` probe (`src/lib/platform.ts:203`)                    | Fatal: `STORAGE_UNAVAILABLE`         |
| `step6_create_http_client`    | `createAuthenticatedClient`; skipped when a client was injected (tests)       | Fatal: `HTTP_CLIENT_INIT_FAILED`     |
| `step6a_bind_session`         | Device/session challenge and response, when a device key pair exists          | Logged, boot continues               |
| `step1_create_app_dir`        | `createAppDir()` (Tauri app dir, or OPFS on web)                              | Fatal: `APP_DIR_CREATION_FAILED`     |
| `step2_initialize_database`   | Opens the database and registers the singleton                                | Fatal: `DATABASE_INIT_FAILED`        |
| `step2b_db_ready`             | `select 1` against the fresh handle, bounded at `dbReadyTimeoutMs` (30 s)     | Fatal: `DATABASE_INIT_FAILED`        |
| `step2d_build_search_index`   | Builds or validates the search index before content                           | Logged; boot continues               |
| `step2c_returning_boot_probe` | `hasCurrentDefaultsVersions` (`src/dal/settings.ts:256`): fresh or returning? | n/a                                  |
| `step3_wait_for_initial_sync` | Awaits or skips PowerSync's priority-1 first sync                             | `waitForInitialSync` never rejects   |
| `step4_reconcile_defaults`    | `reconcileDefaults` (`src/lib/reconcile-defaults.ts`)                         | Fatal: `RECONCILE_DEFAULTS_FAILED`   |
| `step4b_run_data_migrations`  | `runDataMigrations` (`src/lib/data-migrations/index.ts:53`)                   | Swallowed per migration; never fatal |
| `step5_get_settings`          | Reads feature flags and the initial `sidebar_state`                           | n/a                                  |
| `step7_initialize_tray`       | Tauri window/close-handler and tray setup before content                      | Logged; boots with no tray           |
| `step8_initialize_posthog`    | Deferred PostHog client                                                       | Logged; boots with a null client     |

Several steps sit where they do because moving them breaks something no test and no type will
catch, mostly multi-device convergence of default data.

- **Every step is wrapped in `time(label, fn)`**: logs `[init] <label>: <n>ms` and feeds the
  `app_init_timing` event ([TELEMETRY.md](../../../TELEMETRY.md#startup-performance-app_)). Labels
  become property names on that event, so renaming one breaks the existing dashboards.
- **The labels are historical, not execution order.** Client creation and session binding now
  start after the storage check, overlapping binding with the local database open. Binding settles before the key-request responder and initial-sync gate. The mounted session
  observer retains its independent retry if the startup handshake failed. The migration/follower
  check starts after reconciliation and binding.
- **Step 7 preserves the existing native setup boundary before content appears.** Deferring this
  step would extend the window without close-to-tray handling into usable content. On web this step is a no-op.
  Step 8 does not gate content: analytics attaches after a rendering opportunity. Hidden tabs use
  a timer instead, including if the tab becomes hidden while a frame is pending. Browser timer
  throttling still applies, but initialization does not wait for the tab to become visible.
  Retry/unmount cancels pending scheduling and prevents old results from replacing the current app state.
- **`step2b_db_ready` is a bounded `select 1`.** PowerSync defers its expensive ready gate (WASM
  compile, OPFS open, schema replace) to the first query, so absorbing it here keeps `step4`
  measuring reconcile rather than storage setup. The bound matters: a locked or unusable local
  database surfaces here and nowhere earlier (`createAppDir` returns the virtual path `app-data` on
  web without touching OPFS; the step-0.5 probe only opens IndexedDB), and an unbounded await hangs
  the spinner forever.
- **`app_init_timing` fires after analytics settles.** `init_total_ms` includes that deferred work;
  `init_core_ms` measures the shorter blocking pipeline. `app_chat_ready` and `app_content_ready`
  retain their original timestamps if analytics attaches late; only the three fixed startup event
  types can be buffered. Consent is read after the configuration/SDK loads, immediately before
  client initialization.

## Fresh boot vs returning boot

Step 3 can add a substantial user-visible cost: a fresh boot waits up to 10 s
(`initialSyncTimeoutMs`, `src/db/powersync/database.ts:48`) for PowerSync's first sync before
rendering. Step 2c picks the path.

### When does a boot skip the sync wait?

```ts
const canSkipSyncWait = bundleVersionsCurrent && getLocalSetting('syncEnabled')
```

1. **Bundle versions current**, per the probe below.
2. **Sync enabled.** Sync-disabled devices take the fresh path and resolve `'disabled'` immediately
   without a network wait, because `'disabled'` sets `initialSyncCompleted: true`, the only
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

`waitForInitialSync` (`src/db/powersync/database.ts`) awaits
`waitForFirstSync({ priority: initialSyncPriority })`, `initialSyncPriority = 1`, covering the
`user_essentials` and `device_self` streams in
[`powersync-service/config/config.yaml`](../../../powersync-service/config/config.yaml): `settings`,
`models`, `model_profiles`, `devices`, `chat_threads`. The lower-priority `user_data` stream (`chat_messages`,
`tasks`, `skills`, ...) streams in after the app is interactive.

It then waits for this device's own `devices` row. The account streams are gated on that row, so a
device trusted moments ago, whose row hasn't reached the sync service yet, gets a priority-1 sync that
completes empty. The row arrives at the same moment the gated streams unlock. Both waits share the
10 s timeout.

The coupling is by convention only: if the deployed sync config stops declaring priorities, PowerSync
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
- **Atomic**: validation, rebuild and the version marker share one write transaction. Concurrent
  startups recheck readiness after acquiring the transaction, and a failed rebuild rolls back.
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
(`src/lib/fs.ts:89`): close PowerSync, wipe OPFS and the IndexedDB database, rerun the pipeline.

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

## Startup performance boundaries

Core initialization opens storage, reconciles defaults, runs migrations and snapshots the initial
sidebar preference. Native window/tray setup retains its readiness boundary before content appears;
analytics attaches after a rendering opportunity. Only the analytics configuration request has a
five-second timeout. Device binding retains the existing HTTP timeout policy and overlaps database
setup, but its attempt settles before the key responder and initial-sync gate.
The mounted session observer can still retry a failed startup handshake.

Search index setup runs at startup so a missing-index backfill does not block ordinary database
actions during first search. A single transaction makes rebuilds atomic and avoids committing each
schema/backfill statement separately.

Settings reads batch keys into one query. React consumers retain their individual query keys while
sharing one settings-table watcher per database/query cache; the last consumer aborts the watcher
and removes its schema listener. Defaults reconciliation also batches its existence and version
probes inside the existing transaction, preserving the monotonic version and initial-sync gates.

A new chat has no history to load, so it reads the selected model and skips persisted-thread,
message, deletion and trigger lookups. Existing chats retain those lookups. The layout uses the
startup sidebar snapshot until its reactive query resolves, avoiding a blank layout in between.

MCP client/transports and tool configuration discovery load when needed. Markdown attachment cards
stay mounted while a shared query loads their GFM plugin; `react-markdown` remains in the entry bundle
because link rendering already imports its URL transform. Failed downloads leave the existing file
placeholder and controls available. Onboarding forms, chat routes and layout chrome remain static.
UI code splitting requires an error-recovery boundary for failed chunk downloads. Reducing the
initial module graph does not establish the same percentage reduction in visible loading time.

Native apps warm secondary routes serially after core initialization mounts the app, yielding
between imports. This applies to every entry route and can overlap chat hydration. Web builds
retain on-demand route loading, except that SSO deployments preload their small redirect chunk
during startup. SSO redirect analytics reuses the resolved session; it does not add a second
session request before sign-in. Direct visits still wait for the first session resolution;
background session refreshes must not restart an active attempt or dismiss its error screen.
Auth redirects keep the loading indicator visible while navigation commits, and loading indicators share a
rotation phase to reduce jumps when startup hands off to auth or route loading.

The backend uses Better Auth's supported Drizzle joins to read a session and its user in one
database query. This does not cache authentication decisions: expiry, revocation and account
changes are still read from the database on each request.

### Measuring changes

Compare production builds from the same base revision with the same device, dataset, session,
route, sync/encryption state and cache conditions. Report fresh profiles and returning reloads
separately. A deliberately delayed service is a useful regression scenario, but must be labeled as
an injected delay rather than representative production latency.

`app_content_ready` follows committed chat content and two animation frames, or a timer when the
page is hidden. It preserves an early milestone even if analytics attaches later. This is a rendering-opportunity measurement, not proof
of compositor paint or first-send readiness; a visible onboarding dialog can still cover the
composer. Keep navigation-to-content alongside spinner-to-content so moving the spinner cannot
manufacture a gain. Video/filmstrip review supplies the visual check.

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
