# Performance harness

Run real Thunderbolt interactions in a production build with a deterministic local provider. The harness imports 120 markdown messages, 40 sidebar chats and 12 additional models through the normal backup importer. It exercises first send, streaming, opening and scrolling a long chat, typing, model search, Add to chat, global search, desktop/mobile sidebar transitions, chat rename and settings dialogs. Every interaction has a correctness assertion.

## Run

Requires Bun, Node.js (for Vite), Bash, jq and curl, plus the repository's Chrome Stable installation.

```sh
bun install --frozen-lockfile
(cd backend && bun install --frozen-lockfile)
bun run browsers:install
bun run perf:build -- qa-dist-perf-before
bun run perf:serve -- qa-dist-perf-before
```

Leave the server running. In another terminal:

```sh
bun run perf -- --label before
```

The default run is three fresh browser contexts per desktop/mobile profile at 4× CPU slowdown. Authentication and inference use local services. The stack uses a dedicated port range (frontend 1436, backend 8016); `scripts/performance/stack.sh` reuses the existing QA stack and forces its fake-provider/PGlite mode. Custom `QA_*_PORT` overrides must be the same when building and serving; pass the matching frontend `--url` to the runner. Run from a clean worktree without developer `.env` overrides for reproducible builds.

Browser runners accept only loopback HTTP(S) origins without embedded credentials, paths, query strings or fragments. This validates the supplied frontend address; it is not a network sandbox for an arbitrary build. Use the provided fake-provider stack, whose build config points authentication and inference at local services.

After edits, build a separate output, stop the baseline stack with Ctrl-C, and serve the changed build:

```sh
bun run perf:build -- qa-dist-perf-after
bun run perf:serve -- qa-dist-perf-after
bun run perf -- --label after
bun run perf:compare -- qa-out-performance/before.json qa-out-performance/after.json
```

Use `--profile desktop` or `--profile mobile`, `--runs 1`, and `--cpu 1` for shorter investigations. Comparisons require the same Chrome version, platform, CPU throttle, repetitions and scenario set. Keep builds, tests and other CPU-heavy work out of measurement runs. Repeat surprising results; three samples are directional evidence, not statistical certainty. Build directories, reports and screenshots are gitignored. The runner stores loaded entry-script URLs to identify the served build separately from its own source revision.

## Focused paired measurements

Use the full suite to discover problematic flows. Use the paired runner to evaluate a specific fix: its measured windows use cached click coordinates, browser keyboard/touch input and small CSS/DOM predicates. Expensive accessibility queries and correctness assertions run outside the window. Chrome still measures the small amount of driver code executing in the page; traces are necessary before attributing a task to the app.

Serve both production outputs with the same local backend and provider, then alternate before/after order:

```sh
bun run perf:serve -- qa-dist-perf-before qa-dist-perf-after
bun run perf:paired -- --pairs 3 --profile mobile --label paired-mobile
bun run perf:paired -- --pairs 3 --profile desktop --label paired-desktop
# For a focused change, avoid unrelated journeys:
bun run perf:paired -- --pairs 5 --journeys typing --label typing
```

The default URLs are before `http://localhost:1436` and after `http://localhost:1437`; override `--before` and `--after` together when using another port band. Each pair uses fresh contexts and alternates AB/BA order. Default journeys are `open-chat`, `typing`, `overlays` (model menu plus desktop reasoning panel), and `stream`. The optional `--journeys first-token` measures send through the first visible heading in the new long-fixture reply, then completes and validates the stream outside that window. It requires `--stream long` and includes the recorder's normal paint drain; the heading is a visible-response milestone, not the provider's exact first-byte time. Overlay opening and closing settle for 500 ms to include the mobile animation and delayed unmount. Reports contain per-pair samples, loaded script URLs, fixture versions, and retained heap/DOM/listener snapshots collected after GC outside the measured windows; the console prints median paired CPU differences. These prepared/finished snapshots differ from the full suite's separate ten-cycle dialog retention test. Do not compare the paired runner's CPU totals with the full suite's assertion-inclusive totals.

The stream journey submits a named test prompt that opts the local fake provider into 16 deterministic markdown sections, emitted in 24-character chunks at 12 ms intervals. The report records the exact character/chunk counts and fixture version. Ordinary messages retain the original word-at-a-time response; `--stream short` measures that response instead. The long fixture checks code fences, tables and completed text without credentials or app-only test APIs. It also includes reference-style link text, which the existing per-block renderer currently displays literally; this harness does not assert support for cross-block reference resolution.

For attribution, add `--trace --pairs 1 --journeys typing` (or another journey). These diagnostic runs do not print benchmark comparisons. Both runners record Event Timing input, processing and inferred presentation portions; the last is rounded by Chrome's 8 ms duration precision. Supported Chrome builds also provide long-animation-frame script attribution in `raw.longAnimationFrames`, including source URL, function, invoker and forced style/layout duration. The paired runner drains after a paint before stopping so immediate actions do not lose pending Event Timing entries.

Historical schema-1 full-suite reports include substantial Playwright accessibility-query/assertion overhead. Keep them as broad discovery evidence, not app-only CPU measurements. Fixture version 2 adds a completed reasoning part for panel regressions; the full-suite comparator rejects changed fixtures, methodology or schema. Regenerate both sides when changing fixtures or instrumentation.

The reviewed runners use report schema 3 for full/paired runs and schema 2 for startup/large-session runs. These versions add failure/cleanup diagnostics, stricter comparison validation, and pointer actionability checks before recording; startup also preserves redirect hops and out-of-order 304 metadata. Do not combine them with earlier reports. Failed artifact capture still attempts the remaining artifacts and browser/profile cleanup, writes an incomplete JSON report, and exits unsuccessfully. Full/paired runs reject a served entry script changing between repetitions. `perf:compare` accepts full-suite reports only and checks finite metrics plus one sample per scenario and run.

## Startup measurements

```sh
bun run perf:startup -- --url http://localhost:1436 --runs 3 --profile mobile --label startup-before
# After building and serving the candidate, repeat with the same options and a new label.
bun run perf:startup -- --url http://localhost:1436 --runs 1 --profile mobile --label startup-trace --trace
```

Each run creates a fresh temporary Chrome profile. The cold signed-out measurement starts at navigation and ends after the visible Email field accepts browser input, enables Continue, and passes a paint opportunity. Sign-in and fixture import happen afterward, outside timing. Chrome then closes completely and relaunches the same profile, preserving the actual OPFS/IndexedDB/auth state while stopping SharedWorkers. The returning measurement ends after the composer accepts a key and enables Send. `controlReadyMs` records the first visible, enabled, hit-testable field; `usableMs` is a conservative validation milestone that also includes CDP input delivery, condition polling and two paint opportunities. Their difference is not pure input latency: use the separate Event Timing entries for that. No message or sign-in request is submitted by the timed input checks. A separate one-second post-ready window records deferred startup work. The runner verifies that the imported conversation survives the restart, then removes its temporary profile.

`--chat long` opens the imported 120-message conversation on return; the default opens a new chat with the populated database/sidebar. HTTP caching is allowed by default; fresh profiles begin empty and returning profiles retain their cache. `--cache cold` clears/disables HTTP caching for both measurements. Neither mode claims cold OS filesystem caches or represents physical-phone hardware. Actual user agent, touch points and an inferred mobile platform are recorded because viewport/touch emulation can activate different platform branches on different hosts.

Reports include Navigation/Paint and Resource Timing entries, actual CDP response compression headers and encoded transfer bytes, cache flags and network status (including 304 revalidation), main-thread task/script/style/layout counters, frame/long-task attribution, existing `thunderbolt:*` boot marks, and `[init]` phase logs. `networkStatus` preserves the actual 304 even when the main response reports its cached 200; `encodedBodySize` can describe a cached body and must not be counted as newly downloaded bytes. Resource collection ends after the post-ready window; unfinished requests remain incomplete. Page-target metrics can omit worker-internal requests/CPU. No network shaping is applied: loopback behavior and Vite preview compression must not be presented as production network performance. The trace provides parser/compiler attribution and startup screenshots; there is no separate parse-time counter in the ordinary report. Traces are diagnostic and should not be compared with untraced timing runs.

Compare the same startup phase, route, cache policy, browser, profile, CPU rate and fixture version across builds. The full-suite comparator deliberately rejects startup reports because their milestones and sample structure differ.

## Large accounts and longer sessions

```sh
bun run perf:large-session -- --url http://localhost:1436 --label large-before
# Repeat against the candidate with identical fixture and cycle options.
bun run perf:large-session -- --url http://localhost:1437 --label large-after
```

This workload imports 2,000 short chats with four messages each, six 240-message conversations, and an empty checkpoint chat through the supported backup UI. It warms the six long conversations, then revisits the same chats for three blocks of twelve cycles. Search, navigation, typing and menus exercise the populated account without sending new messages. Checkpoints return to the same route before collecting renderer counters, so intentional history growth and different mounted screens do not masquerade as leaks. A final reload provides a separate renderer-reset comparison. Counts are configurable with `--chats`, `--messages-per-chat`, `--long-chats`, `--long-messages`, `--cycles` and `--blocks`; preserve every option across a comparison.

Fixture validation caps the browser workload at 10,000 populated chats, 10,000 messages per history and 100,000 total messages before allocating its backup. Long histories must contain an even number of messages so their last row is an assistant. Use the SQL-only diagnostic for larger database workloads.

Chromium uses the normal 4× CPU profile and post-GC heap/DOM/listener snapshots. Resource counts omit shared-worker heaps and GPU memory. Repeated growth after warmup is an investigation lead, not by itself proof of a leak. For a shorter plateau check, use `--cycles 6 --blocks 3` on both builds; each block still revisits all six default long chats.

The installed macOS Playwright WebKit 27.2 does **not** isolate OPFS between temporary persistent profiles: a blank-page diagnostic wrote an owned marker in one profile and read it in another after the first profile directory was removed. Local storage and IndexedDB were empty in both, while the app's existing OPFS database remained shared. Its private contexts disable OPFS and select the app's in-memory fallback. Earlier WebKit reports are retained as diagnostic artifacts, but do not establish an isolated fixture or valid performance/retention evidence. The WebKit mode has been removed; this runner now supports Chromium only and rejects `--engine`. Reintroduce another engine only after its storage isolation is verified. Do not delete shared OPFS data to make a run pass. Desktop-hosted WebKit would still not represent physical iPhone hardware or its software keyboard.

`bun run perf:search-index` isolates search-index write amplification in native Bun SQLite using PowerSync-shaped JSON backing rows and the generated FTS triggers. It compares searchable-content edits with metadata-only updates, validates result parity, and reports rebuild cost. This is a database diagnostic, not browser latency or a substitute for the browser workload.

## What the report means

| Measurement                     | Meaning and limit                                                                                                                                                                                                                                                         |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Task/script/layout milliseconds | Chrome renderer CPU counters within the measured action plus a fixed settle interval. Does not include server/worker CPU.                                                                                                                                                 |
| Frame gaps                      | `requestAnimationFrame` intervals while the action runs. Reveals main-thread stalls, not compositor/GPU FPS. First-frame latency is recorded separately.                                                                                                                  |
| Blocking time                   | Sum of the portion above 50 ms for observed long tasks.                                                                                                                                                                                                                   |
| Event Timing                    | Input delay and event-to-next-paint duration, grouped by interaction ID. Chrome omits events below 16 ms; no observations are reported as null, not zero. This short scripted sample is not a field INP score.                                                            |
| React commits                   | Root commits counted with an injected DevTools hook, without traversing Fiber or using a profiling build. Component render tests attribute avoidable work.                                                                                                                |
| Action milliseconds             | Playwright action and correctness-wait time, including automation overhead. First-send ends when the user bubble is on screen with nonzero ancestor opacity; the reply stream is measured separately. This is a visibility proxy, not a screenshot-level paint guarantee. |
| Heap/DOM/listener snapshots     | Trends, not leak verdicts. Separate retention samples warm a dialog then run ten open/Cancel cycles, forcing GC outside interaction timing before/after the sequence.                                                                                                     |

CPU throttling and mobile viewport emulation are repeatable desktop proxies; they do not reproduce a real phone's GPU, memory pressure, thermal state or WebKit. Recheck important visual changes on a physical device before claiming native-device smoothness.

## Diagnose a stall

```sh
bun run perf -- --label diagnosis --runs 1 --profile mobile --trace
```

Load the generated `*.trace.json` in Chrome DevTools Performance. It contains main-thread activity and screenshot frames, plus separate PNGs after each scenario. Untraced runs save only a final screenshot. Tracing is deliberately separate from benchmark runs because capture adds overhead; `perf:compare` rejects trace-enabled reports. The raw JSON preserves individual frame intervals, long tasks and event samples rather than only averages.

The harness is ordinary Playwright and CDP code under `scripts/performance/`, outside normal e2e discovery and the production bundle. Add scenarios in `scenarios.ts`, keep fixture data stable for before/after runs, and use supported app UI instead of exposing privileged database/test globals.

Browser regressions live in `e2e/consumer-chat-streaming.spec.ts` (first send, caret-driven slash selection, quote/context controls, reduced-motion high-rate streaming and reload persistence) and `e2e/consumer-content-panel.spec.ts` (mouse/keyboard resize persistence). The existing native smoke flows in `e2e/native-smoke/ios.yaml` and `e2e/native-smoke/linux.ts` were checked: their composer, model-picker, Send and reply selectors remain valid, so they need no selector edits. A browser emulation run does not count as executing those native flows.

```sh
bun run test:performance
```

For isolated markdown-parser attribution, run `bun scripts/performance/markdown-benchmark.ts`. It reports warm median/p90 timings for opening 120 messages and incrementally parsing a longer answer. These Bun timings exclude React, browser layout and CPU throttling; confirm gains with the browser scenarios.

The reusable agent workflow is [thunder-performance](../../../.agents/skills/thunder-performance/SKILL.md).
