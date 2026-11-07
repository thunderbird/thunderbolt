# Performance findings — November 6, 2026

Baseline: `main` at `bb78f20b3b1f5517e39a8669d4a9c91a8ff7a69d`. Changes are on `codex/instant-performance`. No production profiling hooks or new runtime dependencies were added.

## Measurements

The [harness](performance.md) exercised 21 desktop and 19 mobile interaction scenarios, three fresh contexts each, before and after the first set of changes: 240 successful measured actions. Chrome 156.0.8078.80 on macOS arm64, 4× CPU throttling, desktop 1440×1000 and mobile 390×844. The fixture has 120 messages, 40 sidebar chats and 12 extra models.

These first-cycle windows include Playwright actions and assertions. A subsequent CPU trace identified significant accessibility-tree work from Playwright, especially while waiting for a large conversation to render. The CPU/frame values below therefore describe the entire scripted workload, including its driver; they are not isolated app CPU or click-to-paint measurements. The second cycle uses coordinate input and lightweight DOM completion checks inside timing windows, with accessibility assertions after measurement.

Sequential runs showed noticeable host/timing variation, so a second mobile check alternated baseline and changed builds in the order before/after/after/before/before/after. It replayed the same chat scenarios through typing, three samples per build. Both builds used the same local backend; background Tinfoil attestation was disabled for both sides of this check.

| Workload                                          |   Before |    After | Evidence                                       |
| ------------------------------------------------- | -------: | -------: | ---------------------------------------------- |
| Desktop typing, React commits                     |      109 |       54 | Full browser run medians                       |
| Desktop typing, main-thread task time             | 1,122 ms |   848 ms | 24% less CPU over the complete typing sequence |
| Mobile typing, React commits                      |      109 |       54 | Alternating browser run medians                |
| Mobile typing, main-thread task time              |   910 ms |   721 ms | 21% less CPU over the complete typing sequence |
| Desktop long-chat opening, task time              |   829 ms |   615 ms | Full browser run medians                       |
| Desktop long-chat opening, maximum frame gap      |   483 ms |   333 ms | Full browser run medians                       |
| Mobile long-chat opening, maximum frame gap       |   383 ms |   317 ms | Alternating browser run medians                |
| Mobile first-send visibility check                |   596 ms |   405 ms | Alternating runs; includes automation overhead |
| Parse 120 messages, isolated Bun median           | 37.08 ms | 14.51 ms | 21 samples after five warmups                  |
| Incremental markdown parsing, isolated Bun median | 24.70 ms |  8.83 ms | 21 samples after five warmups                  |

These numbers describe the measured workloads, not a promise about every device. In the alternating check, mobile long-chat total task time was effectively unchanged (789 → 802 ms) even though the worst frame gap improved. The sequential mobile typing CPU result was also noisy (873 → 920 ms); alternating runs confirmed the reduction, with exactly the same commit-count improvement in every run. No blanket CPU or frame-rate improvement is claimed for menus, scrolling, or all streaming windows.

## Changes retained

- `useSlashCommand` commits text and caret together and ignores unchanged selection notifications. A regression test changes from 40 to 20 commits for 20 input/select pairs; autocomplete still opens at the current caret.
- `ChatPromptInput` is memoized at its existing component boundary. Twenty unrelated parent updates caused 21 composer renders before and zero after; its own draft, context, SDK subscriptions and imperative ref remain active.
- The latest user message receives a stable attachment-resend callback. Twenty assistant updates caused 20 unchanged user-bubble renders before and zero after.
- Partial-save message notifications use the existing 150 ms bookkeeping throttle. Thirty token updates cause at most five commits rather than thirty. The SDK's independent status channel still cancels trailing saves immediately; final-save ownership is unchanged.
- Mobile first send removes the greeting's 150 ms exit wait. The message entrance animation remains, and the composer stays mounted.
- The markdown splitter reuses an exact-input parse and maps already-parsed remaining segments instead of parsing them again. It adds no cross-message cache. Prefix/property equivalence tests cover lists, tables, math, code fences, indented code and reference definitions.

A proposed sidebar-resize optimization was discarded after verifying that the component was never mounted. No unused-path optimization or speculative virtualization was retained.

## Follow-up cycle

Three additional small changes survived source review and behavioral tests:

- The pinned-skills bar now unmounts once a conversation has messages. Previously it returned `null` after running three skill-query hooks on every composer render. New-chat chips and ongoing slash insertion retain their own behavior.
- Completed text no longer subscribes to `prefers-reduced-motion`. Each actively streaming text part still observes changes immediately, and starting a new stream reads the current preference. This removes one unnecessary listener per historical assistant text part.
- The desktop content panel persists a settled resize through the panel library's `onLayoutChanged` callback. Opening and closing animations no longer save transient widths to SQLite. Keyboard resizing and pointer release still persist, including changes below 1%; interrupted animations cancel and resume from the visible width.

The panel browser regression exposed an existing `Matching panels not found` error on keyboard resizing: its separator was nested inside a wrapper, but the library associates separators with direct group children. Making the separator a direct child fixes that integration while keeping its grip and webview cursor mask.

The investigation also tested candidates that were deliberately left unchanged:

| Candidate                                     | Evidence                                                                                                                                                                                          | Decision                                                                                                                                                                                 |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Mobile sidebar style invalidation             | Three interleaved warm samples per variant: baseline open/close style medians 52.37/53.11 ms; suppressing only `--kb` gives 51.07/53.81 ms. Diagnostic suppression of `inert` gives 9.09/8.17 ms. | Keep `inert`: it prevents interaction and accessibility focus in the background. Do not trade correct behavior for this approximately 43 ms reduction.                                   |
| Native textarea `field-sizing`                | Real Chrome clone measurements show uncapped heights 6 px shorter; the capped height stays 240 px. Older supported WebKit versions still need the existing fallback.                              | Keep current sizing. Exact parity would add sizing/overlay branches for a modest remaining cost.                                                                                         |
| Share markdown syntax trees with the renderer | ReactMarkdown still parses each block; avoiding that requires changing its parser/plugin integration or rendering structure, including math handling.                                             | Keep the existing renderer. The retained splitter improvement removes duplicate work without an AST cache or renderer fork.                                                              |
| Cache compiled skill queries                  | The PowerSync adapter compiles during render; memoizing only the query wrapper does not eliminate compilation.                                                                                    | Remove the hidden consumer first. Avoid adding a second query cache without a remaining measured need.                                                                                   |
| Memoize the effort selector while typing      | The earlier trace attributes about 18.5 ms across 54 keys to this control. Its closed popover does not mount the model list. It also reads SDK status through its parent render.                  | Leave unchanged: the small measured cost does not justify a new status-prop contract. Raw listener allocations alone do not establish a leak or identify this component as their source. |

Diagnostic artifacts: `mobile-sidebar-diagnostic.json`, `diagnose-mobile-sidebar.ts`, `autosize-field-sizing-dimensions.json`, and `autosize-field-sizing-experiment.ts` under `qa-out-performance/`. The inert experiment is diagnostic only; no production sidebar accessibility changes were made.

The long-stream fixture also exposed an existing markdown limitation: reference links whose definitions land in separate rendered blocks remain literal text. This was reproduced in the preserved baseline build. The regression checks complete text, block structure and reload persistence; it does not claim to repair cross-block references.

### Interaction-cycle focused comparison

The final comparison against original `main` used three alternating mobile pairs with the lighter driver: 120 history messages and a 10,728-character reply delivered in 447 chunks at 12 ms intervals. Medians across the three samples per build:

| Workload                                       | Original main |    Final | Result                             |
| ---------------------------------------------- | ------------: | -------: | ---------------------------------- |
| Long-chat opening, task time                   |      1,118 ms |   873 ms | 22% less measured main-thread work |
| Typing, task time                              |        923 ms |   761 ms | 18% less measured main-thread work |
| Typing, root commits                           |           108 |       54 | Half as many commits               |
| Long reply streaming, task time                |      2,895 ms | 2,472 ms | 15% less measured main-thread work |
| Long reply streaming, root commits             |           763 |      417 | 45% fewer commits                  |
| Finished workload, retained listeners after GC |           845 |      780 | 65 fewer in every pair             |

Median **paired** task-time changes are −225 ms for opening, −194 ms for typing and −423 ms for streaming; these differ from subtracting the independent medians in the table. Model-menu opening/search/closing and send latency show no meaningful consistent improvement. Streaming's p95 frame interval stays 16.7 ms on both builds; the median maximum gap is 50 → 66.7 ms, so lower CPU does **not** imply uniformly better frame pacing. The larger candidate gaps carry Long Animation Frame attribution to an agent-core callback invoked by `FileSystemDirectoryHandle.getDirectoryHandle.then`: a startup-related lead, not proof of a markdown-render regression. Separate send/stream windows can place startup work on different sides of their boundary.

The second-cycle-only desktop comparison shows panel opening at 420 → 373 ms task time and 30 → 20 median commits. Closing is effectively unchanged. The second-cycle mobile CPU results are mixed: three initial pairs looked slower, while two pairs with build origins reversed showed lower typing CPU and nearly unchanged streaming. Desktop typing also increased in that comparison. These smaller CPU differences are not claimed as wins; all raw results, including unfavorable ones, remain in `cycle2-paired-mobile.json`, `cycle2-swapped-mobile.json`, and `cycle2-paired-desktop.json`. Stable reductions in subscriptions, hidden query hooks and animation-time settings writes support the narrow changes without claiming a broad second-cycle speedup.

This was the stopping point for the interaction-only cycle: the overall improvement repeats against `main`, additional menu/typing differences are at the scale of host variation, and the remaining identified options require behavioral or renderer changes disproportionate to their measured benefit. The subsequent audit broadens the search to startup, inactive UI, data access and attachments. No virtualization, syntax-tree cache, extra runtime dependency or production instrumentation was added.

## Startup, inactive UI and data access

The next cycle adds a separate startup driver: fresh browser profiles for signed-out input, followed by a complete browser shutdown/restart with the real imported database and cached authentication. It records actual input handling, existing initialization marks, resource sizes/cache status, CPU and a separate one-second post-ready window. It uses the same Chrome/mobile/4× CPU profile and unshaped loopback network; it does not simulate a cold OS cache or a physical phone.

The frozen interaction candidate is the baseline for this cycle. Its 2,214,416-byte entry script finishes downloading quickly on loopback but contributes approximately 247–256 ms of long-animation-frame script evaluation at 4× CPU. Returning boots cache/revalidate the script yet still evaluate it. The baseline also performs approximately 382 ms of main-thread work in the second after the composer handles input, making deferred startup work a useful target in its own right.

Small changes retained from this audit:

- Compaction summary inspection loads its content on demand. Removing its static barrel export lets the shared markdown implementation leave the entry bundle; the panel retains its local loading boundary. The new entry is 2,162,721 bytes before the subsequent adapter experiment, about 51.7 KB smaller. Chat rendering already warms the shared markdown code, and browser coverage checks first open, formatted content, retained context, close/reopen and draft preservation.
- Closed onboarding no longer mounts wizard settings/integration/passkey hooks. The existing modal portal still owns mount/unmount and exit animations; completion learned from storage still closes it.
- Approval polling requires the setup dialog to remain open. This also stops repeated polls after a failed cancellation; late approval callbacks after dismissal are ignored. Sync-disabled sessions no longer mount pending-device SQL watchers. Sync-enabled sessions keep both watchers active even while the notification is closed.
- Returning **sync-enabled** reconciliation skips four reads when both overwrite and resurrection gates are closed. Model/profile repair and legacy widget restamping still run. SQL tests preserve all five tables and version markers, including insertion of a deliberately missing profile. The standalone browser fixture does not exercise this sync-enabled shortcut.
- Widget cache reads select only `cache`; last-message lookups select only `id` and `modelId`. A representative 60-message diagnostic transfers 7,392,901 JSON bytes for full rows versus 3,421 for cache rows and 5,701 for identities. Query count is unchanged; these are data-volume measurements, not a claim about total app memory or browser latency.
- Responsive layout checks reuse one live `MediaQueryList`. In the 120-message diagnostic, opening allocates 460–462 fewer query objects, 53 typed characters avoid 216, and two breakpoint crossings avoid 820. Listener additions/removals remain identical. Native allocation time was only a few milliseconds per phase, so this is reduced allocation churn without a claimed frame-rate improvement.

Three candidate runs were bracketed by three baseline runs before and three afterward. This exposes host drift rather than selecting the more favorable baseline:

| Mobile startup workload                      | Baseline before | Candidate | Baseline repeat |
| -------------------------------------------- | --------------: | --------: | --------------: |
| Signed-out input usable                      |          851 ms |    777 ms |          780 ms |
| Returning composer usable                    |        1,161 ms |  1,068 ms |        1,095 ms |
| Signed-out boot plus post-ready task time    |          766 ms |    657 ms |          690 ms |
| Returning boot plus post-ready task time     |        1,413 ms |  1,272 ms |        1,316 ms |
| Returning boot plus post-ready React commits |              73 |        69 |              74 |

Cold input latency is effectively unchanged against the repeated baseline; returning usability improves modestly. Combined boot-plus-tail CPU remains lower against both baseline groups, so the reduction is not solely work moving across the readiness boundary. These short local runs support a small startup improvement, not a large universal launch-time claim. “Usable” includes browser input delivery, condition checks and paint opportunities; it is not pure key latency. Raw reports are `startup-baseline-mobile.json`, `startup-candidate-mobile.json` and `startup-baseline-repeat-mobile.json`.

The network audit found one `/config` request per boot, no duplicated asset URLs, and no failed app requests apart from intentionally blocked attestation. The extra session validation request deliberately handles revocation/expiry outside the auth library's retry path. Search-palette warming protects immediate keyboard access, and font transfers are small/cached. Neither policy was changed just to move work out of the measured startup window.

## Broader parallel audit

Looking beyond rendering exposed a larger pre-inference cost: every prompt re-saved its entire SDK transcript. A real SQLite routing regression with 120 existing messages and a new prompt records **241 SQL write attempts before and 3 after**: 121 inserts plus 120 conflict updates becomes two inserts plus one conflict update. Successful row mutations fall from 121 to two. Avoiding historical updates also avoids their search-index and sync work.

The routing boundary now saves the last two messages. Hydrated history is already durable; historical edits, stops, compaction and ACP updates persist their own changed rows. Keeping the immediate predecessor handles the SDK's unawaited prior `onFinish`: that assistant must exist before the new user's parent is chosen. The full transcript still goes to the agent, and title generation still reads the first prompt from the complete session. Tests cover pending final saves, original parent links, edits/retries with changed attachment delivery, consecutive users, empty requests, unchanged historical rows and original-title preservation. No dirty-message cache, new transaction scheme or final-save serialization was introduced.

The same audit split the connection dispatcher by selected agent type. Built-in, hosted HTTP and ACP adapters load independently, with the selected implementation warmed concurrently with the dispatcher at the existing preload point. Attachment-only sends and mount-time warmups take that same path. System-agent validation remains in front of hosted adapter creation; speculative imports absorb navigation failures while awaited connection imports still report real errors.

Two small cleanup fixes address retained resources on exceptional paths: PDF text/image conversion always destroys its loading task, including load/extraction/render failures; native sidebar webviews release resize/move listeners whose asynchronous registration finishes after unmount. The latter was reproduced with delayed native API promises: both new tests fail before the fix and pass afterward. Native hardware execution is still outside these checks.

An attachment-heavy conversation exposed another concrete cost: twelve offscreen PDF cards immediately created twelve PDF workers, blob URLs and canvas previews. PDF thumbnails now reuse the existing latched visibility hook with its 300 px margin. On the same imported history, initial worker/blob/canvas counts fall **12 → 0**; scrolling to the first card creates one of each. Opening the full preview adds one, and closing it releases that preview's worker and blob URL. Card dimensions stay 144 × 176 px in the desktop diagnostic, and the visible before/after screenshots are byte-identical. Once a thumbnail has appeared it stays mounted, avoiding repeat decoding while scrolling. Ordinary image/DOCX/text cards are unchanged. Both desktop and mobile browser flows verify dimensions, first visibility, preview open/close and retained thumbnails. The raw reports are `pdf-thumbnail-base.json` and `pdf-thumbnail-final.json`; their main-thread heap readings exclude worker heaps and canvas/GPU storage, so no total-memory percentage is inferred from them.

### Final expanded comparison

The final build (`entry-BuN3hrxc.js`) was compared with original main (`entry-zs921XbN.js`) in three alternating mobile pairs at 4× CPU. Each fresh context runs first-visible-reply, typing, then another complete streamed reply. Both replies use the same 10,728-character local fixture. Typing therefore occurs after the first additional reply and should not be compared directly with the earlier interaction-only typing numbers.

| Measured workload                              | Original main | Final candidate |
| ---------------------------------------------- | ------------: | --------------: |
| Send to first visible reply heading            |      1,110 ms |          823 ms |
| Typing main-thread task time                   |      1,346 ms |        1,014 ms |
| Typing React commits                           |           109 |              55 |
| Combined send and complete streaming task time |      4,192 ms |        3,237 ms |
| Streaming React commits                        |           707 |             395 |
| Finished post-GC renderer JavaScript heap      |       41.8 MB |         36.6 MB |
| Finished post-GC event listeners               |           848 |             779 |

These are medians of three runs per build; median paired changes are −306 ms for visible reply, −270 ms typing task time, and −955 ms combined send/stream task time. The isolated optimistic-send subphase increases by approximately 14.5 ms in duration and 55.5 ms CPU, while its Event Timing stays 80 ms, maximum frame interval stays 33.3 ms, and observed blocking stays zero. Earlier inference work can enter that short window; the end-to-end visible-reply measurement and combined send/stream totals improve. Typing's median maximum frame interval falls 33.3 → 16.7 ms and streaming's 50 → 33.3 ms in this run, without claiming universally smoother pacing on every device. Retained DOM nodes rise slightly, 5,789 → 5,794. The approximately 5.2 MB heap reduction describes this workload's renderer after GC, not a total process-memory or leak claim.

All fixture assertions pass. `main-to-final-expanded-mobile.json` preserves the raw comparison. `startup-final-smoke.json` verifies signed-out input, returning composer input and database survival on the final build, and confirms that built-in use requests neither hosted nor ACP adapter chunks. Static production-graph inspection agrees: hosted loading also excludes the built-in inference pipeline. The final entry is 2,163,871 decoded bytes, approximately 50.5 KB smaller than the earlier baseline. The single final startup smoke is functional/resource evidence rather than another latency comparison.

Further options were deliberately left alone: changing the mobile keyboard viewport lock needs physical-device evidence; altering FTS storage or triggers would require migration/rebuild and broader database profiling; ordinary history virtualization still has scroll/selection correctness costs. The bounded pre-send save removes the redundant FTS-trigger workload without changing the search schema. No safe additional startup network elimination emerged from the resource audit.

This expanded cycle now reaches diminishing returns for small changes: the independent database, loading, inactive-UI, attachment and resource audits found and validated the remaining concrete opportunities above. Further identified options involve larger rendering/storage changes or platform-specific behavior that these measurements do not justify changing.

## Additional targeted round: large accounts and rich content

This round uses the previous final build as its baseline, preserving the earlier cumulative comparison with main. Parallel audits target larger databases, repeated chat navigation, document previews and maps.

Three small production changes were retained:

- Map widgets reuse the existing latched visibility hook. They wait until they approach the viewport before probing WebGL, importing MapLibre, starting its renderer or animating a loading skeleton. In an 80-message history containing ten offscreen maps, initial map canvases fall **10 → 0**, WebGL allocations including probes **20 → 0**, and style requests **10 → 0**. Reaching the first map creates one renderer and one probe. Once initialized, its canvas and popup survive scrolling; navigating away removes the canvas and releases its map context. The diagnostic uses a deterministic tile-free style, so it measures initialization and resource counts, not real-world tile-network latency. Visible before/after screenshots are byte-identical. Raw evidence is `map-widgets-base.json` and `map-widgets-after.json`.
- Search-index UPDATE triggers compare the old and new indexed values, including row id, title, body, parent and soft-delete visibility. Metadata/cache/context changes that leave those values unchanged skip the FTS delete/reinsert. On the reproducible native SQLite fixture with 2,000 chats and 100,000 messages, metadata-only writes fall **10.63 → 0.005 ms** and chat-context writes **10.88 → 0.002 ms**. At 10,000 messages, the old metadata update costs approximately 1.05 ms. Real content edits still require the existing full index scan and reindex; measured content-edit time is approximately 10.75 → 10.72 ms, with no improvement claimed. Search results remain identical. `search-index-final.json` records all samples and query plans; `bun run perf:search-index` reproduces them.
- DOCX preview object URLs are created only after conversion succeeds and cancellation is checked. Pending, failed and cancelled conversions therefore create no object URL. Successful previews retain the same URL lifetime and cleanup. This removes unnecessary blob retention on failure without claiming a whole-app memory percentage.

The search change uses the existing monotonic index version and transactional rebuild rather than adding a separate migration mechanism. An existing account rebuilds once when it first opens this version. The 100,000-message rebuild takes a median **327 ms** in native in-memory SQLite; the 10,000-message rebuild takes approximately **32 ms**. These timings exclude browser/WASM, storage I/O and phone hardware, so they are attribution evidence rather than launch-time guarantees. Subsequent launches retain the existing version/count fast path. Tests preserve null handling, parent moves, id changes, soft deletion/restoration, rollback and concurrent initialization.

The reusable harness now includes a large-account/long-session workload plus the isolated FTS diagnostic. A WebKit investigation is qualified separately below. The browser fixture has 2,007 chats and 9,440 messages, including six 240-message histories. Each build completes six full warmup cycles followed by three blocks of six cycles at 4× CPU, with 162 measured actions per build. Fixture hashes, browser, profile, warmup and cycle settings match. Search, navigation, typing and model menus run repeatedly without adding messages; retention snapshots always return to the same empty checkpoint route.

| Post-GC checkpoint               | Previous final build | Targeted candidate |
| -------------------------------- | -------------------: | -----------------: |
| Fully warmed renderer heap       |            29.730 MB |          29.765 MB |
| After six measured cycles        |            30.727 MB |          30.727 MB |
| After twelve measured cycles     |            31.166 MB |          31.193 MB |
| After eighteen measured cycles   |            31.419 MB |          31.437 MB |
| Fresh document on the same route |            16.747 MB |          16.750 MB |

After the first measured block, both builds retain exactly 802 DOM nodes and 1,377 listeners through the remaining blocks, with one dedicated worker throughout. Heap growth diminishes across blocks, and the final difference is only 17.5 KB. This workload supports no continuing DOM/listener/worker accumulation over the observed cycles and no material retention difference between builds; it does not prove the absence of all leaks. Retained session history and warmed modules remain until reload. Worker heaps and GPU memory are excluded.

Large-history opening still costs approximately 1,017 → 1,020 ms of main-thread task time at 4× CPU. Other action differences are small or mixed; this is one ordered baseline/candidate run, so no broad latency improvement is inferred. The new fixes target resource-heavy maps and unchanged search writes, neither of which occurs during these no-send retention cycles. `large-account-baseline.json` and `large-account-candidate.json` preserve all action samples and snapshots. The frozen scripts are `entry-BuN3hrxc.js` and `entry-D0yXz6ki.js` respectively.

The earlier WebKit 27.2 run completed six warmup cycles and six measured cycles (54 actions), including reload, but **its fixture was not isolated**. A later small-fixture smoke navigated to the previous 2,007-chat fixture's checkpoint. A blank-page diagnostic then confirmed that two fresh temporary persistent profiles share OPFS even after the first profile directory is removed: an owned marker written by one profile was readable in the other, while local storage and IndexedDB were empty. This reproduces without loading Thunderbolt. Private WebKit contexts disable OPFS and use the app's in-memory fallback instead, so neither mode currently provides a verified isolated durable fixture on this host. `large-account-webkit.json`, `review-webkit-smoke.json` and `webkit-isolation.json` remain diagnostic artifacts; the earlier successful report must not support performance or retention claims. No shared app database was deleted. The user chose to remove the WebKit mode until reliable storage isolation is available. The runner is now Chromium-only; Chromium results are unaffected.

## Side-worktree integration and main catch-up

After the targeted measurements, this branch was fast-forwarded to main commit `1ad05ed4646fc2de0ddd4af3ce3e56de60b204be` and the performance changes were reconciled with its lifecycle fixes. Closed-onboarding gating is retained around the updated onboarding flow. Main already includes open-gated approval polling and late native-webview listener cleanup; their current implementations are preserved alongside the relevant regression coverage.

The independent changes from `codex/visible-chat-performance` are incorporated: completed text parts compare their text, state and citation inputs instead of cloned SDK object identity, and drawer/sheet/mobile-sidebar transitions settle in 200 ms with their existing swipe and reduced-motion behavior. The side worktree's search guard duplicates the tested guard here, so this branch keeps its own implementation and broader tests. Its bounded approval-test wait and key-store isolation are also retained where applicable.

Conversation virtualization, its scrolling/reveal hooks, full-transcript controls and translations are excluded. The side worktree's 44–48% history-opening improvement includes virtualization and does not describe this integration. The measurements above identify the frozen builds tested before the main catch-up; they are not presented as fresh aggregate measurements of the combined checkout.

A final two-pair alternating mobile check at 4× CPU compares the targeted build (`entry-D0yXz6ki.js`) with the combined build (`entry-Chv9MAZv.js`). All 28 measured windows and their content assertions complete. Maximum frame intervals remain 33.3 ms in every window. First-visible-reply latency spans 596–662 ms before and 627–652 ms after; typing times are mixed. The integrated build uses an additional 45–67 ms of main-thread task time in the first-visible-reply window and 18–27 ms across the separate complete send/stream workload. Finished post-GC DOM nodes and listeners match exactly (5,868 and 783); renderer heap is approximately 0.15–0.18 MB higher. This short check includes all main changes as well as the imported fixes: it supports unchanged observed frame pacing, not a new aggregate speedup or proof of performance equivalence. `integrated-mobile.json` preserves both pairs, served asset identities and retention snapshots.

## Review of the combined branch

The architecture, security and lifecycle review found and fixed a panel-width race: reopening before the settings write/refetch finished restored the old width. A temporary preference now lasts only until the latest write settles, including failure; an older write cannot clear a newer resize. Regression coverage also exercises failed prompt persistence/retry, consecutive replies, unmount with pending notification/save timers, late/replaced/removed citations, attachment resend after a new user turn, and document downloads/conversions completing after cancellation.

Harness review tightened report-family/schema validation, scenario repetition checks, local-only origins and backend binding, and fixture allocation limits. Startup transfer accounting now retains redirect hops and correlates out-of-order cache-status events. Trace streaming and shared finalization preserve the primary error while attempting all resource cleanup; artifact failures make the run fail rather than silently producing a successful report. Repeated interaction preparation and backup-import UI scaffolding are shared. Unused fake-provider customization was removed, and malformed requests return a controlled error instead of escaping an async server handler. Runner schema versions changed so the revised instrumentation cannot silently compare against older full-suite reports.

A randomized run reproduced a test-only race in approval setup: a fixed number of fake-clock ticks could finish before real IndexedDB/WebCrypto work. The test now uses the existing bounded real-time wait while advancing its fake clock. The original ten-run reproduction failed every time; the corrected repeat passes all 50 cases, and the complete frontend suite passes the same random seed. Separate long timeouts in that run matched recorded laptop sleep intervals; those browser checks passed unchanged after wake. No timeout limits or production approval behavior were relaxed.

## Memory and remaining issues

Ten warm dialog open/Cancel cycles retained **zero additional documents, DOM nodes or event listeners** in every baseline and changed run. Median post-GC heap growth remained small and similar: desktop approximately 213 → 229 KB, mobile 356 → 349 KB. This is not evidence of a memory leak fix or a general retained-memory reduction.

The interaction-cycle broad validation repeats ten cycles on each profile with the same zero document/node/listener deltas. Used-heap growth is approximately 221 KB desktop and 350 KB mobile. That cycle's finished long-chat workload retains 65 fewer listeners and one fewer DOM node; heap medians remain close (39.99 → 39.86 MB), so no general heap-memory percentage improvement is claimed from that earlier result. The expanded cycle's retained-heap reduction is reported separately above.

Opening a 120-message history still has a substantial synchronous rendering stall. Virtualizing variable-height messages could address that, but it must preserve scroll anchoring, search jumps, text selection, message actions and streaming behavior. It was not added as an unverified shortcut.

Some apparent overlay long tasks included Playwright accessibility-tree generation and must not be attributed to the app without a trace. In the earlier runs, mobile menu/dialog close action times around 0.9 seconds were mostly an assertion-polling artifact: the drawer exit was 400 ms, and Playwright could next poll after about 770 ms. The side-worktree integration now shortens that transition to 200 ms. Use trace transition events and screenshots to distinguish real UI latency from assertion completion.

The fake reply has eleven chunks spaced 150 ms apart. It validates the complete transport path, but high-rate streaming render reductions are demonstrated by the targeted token-update tests rather than by that short reply. First-send and reply-stream windows also shift when the sent bubble appears sooner; compare their combined work before attributing a stream-only difference.

## Verification and artifacts

- The first-cycle scoped frontend/shared suite passed all 8,184 tests. Focused parser/renderer suites also passed 81 tests and 5,018 assertions, including 4,527 parser-equivalence assertions.
- Frontend, e2e and harness TypeScript checks passed. Harness metric/comparison tests, repository ESLint (existing warnings only), license headers, and touched-file formatting passed.
- Both production builds completed. All full-run interaction assertions and the alternating mobile checks passed. The reusable skill passed its validator.
- `qa-out-performance/before.json`, `after.json`, and `comparison.md` hold the full results, including less favorable/noisy measurements. `paired-mobile.json` and its local replay script preserve the follow-up experiment. Build script URLs in the reports identify the served assets separately from the runner checkout.
- `qa-out-performance/diagnosis-mobile-1.trace.json` contains CPU profile events and 450 screenshot frames; per-scenario PNGs were also saved. Mobile screenshots were reviewed for first send, long-chat rendering, the model picker and confirmation dialogs. Trace-enabled runs are excluded from benchmark comparisons.
- The follow-up scoped suites pass all 8,196 tests. Five browser regressions pass with one expected mobile skip for the desktop-only resizable panel; the panel was also rechecked with account-unique fixture IDs. These cover first send, caret/slash selection, quoting/context controls, skill-bar remount, reduced-motion streaming, draft/focus preservation, reload persistence and pointer/keyboard width restoration. Native smoke selectors were reviewed, but native hardware flows were not run.
- `main-to-final-mobile.json` and `paired-results.md` preserve the final focused comparison and all second-cycle results. `final-validation.json` contains 40 successful broad desktop/mobile actions plus the two ten-cycle retention checks. The reusable harness has no timing thresholds in CI; CI checks its metrics, comparison guards and TypeScript instead.
- After the broader audit, the complete scoped suite passes 8,233 tests, plus three harness metric/comparison tests. Frontend/e2e/harness TypeScript, ESLint (zero errors, 323 existing warnings), license headers and collection of all 68 e2e spec files pass. Final browser coverage passes 13 desktop/mobile cases with one expected mobile skip for the desktop resize panel. This includes long-history send/reload persistence, lazy summary inspection, closed-onboarding queries and PDF preview visibility. The added PowerSync E2EE cancellation-polling regression is type-checked but not executed: that dedicated service stack is not running in this local performance environment.
- The additional targeted round passes 8,245 scoped tests (7,526 frontend, 714 shared/scripts, five e2e units), plus the harness checks. Six affected desktop/mobile browser cases pass: map visibility/state retention, PDF preview lifecycle, and new-message/title search with reload. ESLint has zero errors and the same 323 existing warnings; all 70 e2e spec files are collected. An initial randomized device-approval snapshot test failed once, then passed standalone, with the exact full-suite seed, and in the final complete run. Its assertion now includes the surfaced error to make a recurrence diagnosable; no approval behavior was changed. The shared-script suite needs sandbox escalation for its temporary local HTTP servers.
- After integrating main and the independent side-worktree changes, all 8,560 scoped tests and three harness tests pass. Frontend/e2e/harness TypeScript, production build, license headers and touched-file formatting pass; ESLint reports zero errors and 308 existing warnings, and all 71 e2e spec files are collected. The combined production build (`entry-Chv9MAZv.js`) passes 18 desktop/mobile browser cases, with one expected mobile skip for the mouse/keyboard resize case. These include streaming, long-history persistence, summary panels, closed-onboarding queries, map/PDF visibility, search after reload, and the imported 200 ms transitions with focus return and draft preservation. The dedicated PowerSync E2EE stack and native hardware flows remain outside this local run.

- The reviewed source passes 8,576 scoped tests (7,856 frontend, 714 shared/scripts and six fixture units), plus 19 harness tests. Frontend/e2e/harness types, production build, touched-file formatting checks and license checks pass; ESLint has zero errors and 308 existing warnings. All 71 e2e spec files are collected. Eighteen desktop/mobile regressions pass, and the five applicable panel/onboarding cases pass again on the final build (`entry-CTFcezzm.js`), with one expected mobile skip for desktop resizing. The actual disposable Postgres/PowerSync multi-device cancellation test now passes too: envelope polling stops after dismissal and the device remains untrusted. Native hardware flows were not run.
- Final Chromium harness smokes exercise the full suite with streamed trace capture, a same-build paired run, startup and a small repeated-session fixture. These are functional checks at 1× CPU, not new before/after performance evidence. Deliberately unreachable local origins also exercise failure reporting and resource cleanup in all four runners. Startup additionally reports an expected screenshot failure on the uncommitted error page without hiding the original connection error. Raw files use the `review-*-smoke` and `review-*-failure` labels.

Outputs stay local and gitignored. Reproduce the workflow with the [performance guide](performance.md) or the [thunder-performance skill](../../../.agents/skills/thunder-performance/SKILL.md).
