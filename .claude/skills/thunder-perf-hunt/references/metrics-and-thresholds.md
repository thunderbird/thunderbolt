# Metrics & thresholds

Every number the harness can raise a finding on, what it means, how it is captured, and where source attribution comes from. Thresholds are defined once in `scripts/report.ts` (constants at the top) and `scripts/lib/inject.ts` (`rate()` in `READ_SNAPSHOT`). Do not hardcode different numbers elsewhere — read them from there.

All metrics are captured with **native `PerformanceObserver`s installed inline via `page.addInitScript`** (`INIT_SCRIPT` in `scripts/lib/inject.ts`). The script runs at document start, before any app code, and each observer uses `buffered: true` so entries that fire during first paint are not missed. No cross-origin script is loaded — the app ships `COEP: credentialless`, which would block a CDN `<script>`, so everything is inlined into `window.__PERF_HUNT__`.

## Core Web Vitals

`READ_SNAPSHOT` rates each vital `good` / `needs-improvement` / `poor` against these cutoffs. `report.ts` skips anything rated `good`; `needs-improvement` → severity `medium`, `poor` → severity `high`. Confidence is `high` (deterministic measurement).

| Metric | good ≤ | needs-improvement ≤ | poor > | Unit | Observer `type` |
| --- | --- | --- | --- | --- | --- |
| LCP — Largest Contentful Paint | 2500 | 4000 | 4000 | ms | `largest-contentful-paint` |
| INP — Interaction to Next Paint | 200 | 500 | 500 | ms | `event` (proxy, see caveat) |
| CLS — Cumulative Layout Shift | 0.1 | 0.25 | 0.25 | unitless | `layout-shift` |
| FCP — First Contentful Paint | 1800 | 3000 | 3000 | ms | `paint` |
| TTFB — Time To First Byte | 800 | 1800 | 1800 | ms | `navigation` |

What each means and how attribution works:

- **LCP** — time until the largest above-the-fold element paints. Captured as `entry.startTime`; attribution is the element's CSS selector via `cssPath(entry.element)`, falling back to `entry.url` for image LCP. Fix targets the attributed element (oversized image, late-mounting hero, blocking font).
- **INP** — worst interaction latency. The harness observes `event` entries with `interactionId` and `durationThreshold: 40`, keeping the max `duration`; attribution is `cssPath(entry.target)` — the element the user interacted with. This is an approximation of the real web-vitals INP algorithm (which buckets by interaction), good enough for finding the slow interaction, not for reporting a field-accurate score.
- **CLS** — summed layout-shift `value` excluding `hadRecentInput` shifts; attribution is the CSS selector of the first shifting node's source. Fix targets reserved space / dimensions for that node.
- **FCP** — first text/image paint (`first-contentful-paint` paint entry). No element attribution.
- **TTFB** — `navigation.responseStart`. For this app served from a local dev server, TTFB is mostly meaningless; treat a `poor` TTFB on `localhost` as noise unless reproduced against a production-like build.

## Long tasks — `duration ≥ 120ms` (`LONG_TASK_MS`)

Captured via the `longtask` observer. Each sample records `duration`, `startTime`, and an `attribution` container name (e.g. `"self"`, `"same-origin"`) from `entry.attribution[0].name`. `report.ts` raises the **top 3** long tasks per scenario; `duration ≥ 300ms` → `high`, else `medium`; confidence `medium` (longtask attribution is coarse — it does not name a function). Cross-reference LoAF for a precise source location on the same frame.

## Long Animation Frames (LoAF) — `duration ≥ 200ms` (`LOAF_MS`)

Captured via the `long-animation-frame` observer. Richer than `longtask`: each LoAF exposes `duration`, `blockingDuration`, and a `scripts[]` array with **per-script source attribution**:

- `sourceURL`, `sourceFunctionName`, `sourceCharPosition` — the exact file, function, and character offset of the script that ran. `report.ts` picks the longest-running script and emits `sourceURL:sourceCharPosition sourceFunctionName` as `sourceAttribution`. This is the single best signal for pinning a long task to code.
- `invoker` — what triggered the script (event listener, timer, etc.).

A LoAF ≥ 200ms → category `long-task`; `duration ≥ 400ms` → `high`, else `medium`; confidence `high`.

## Layout thrash — `forcedStyleAndLayoutDuration ≥ 30ms` (`FORCED_LAYOUT_MS`)

Derived from the same LoAF entries: `INIT_SCRIPT` sums each script's `forcedStyleAndLayoutDuration` per frame. When that sum ≥ 30ms, the finding is re-categorized `layout-thrash` (not `long-task`) — this is the fingerprint of a forced synchronous reflow (read layout → write style → read layout in a loop). Note a LoAF can trip the thrash threshold even when its total `duration` is under 200ms. Fix per `fix-playbook.md` (batch reads/writes; avoid reading `offsetWidth`/`getBoundingClientRect` mid-write).

## Memory leak — `deltaBytes ≥ 3MB` (`HEAP_LEAK_BYTES`) **or** `detachedNodesDelta > 0`

`HeapDelta` samples compare heap `before`/`after` a repeated interaction boundary (mount/unmount cycles, opening/closing a panel). Either a ≥3MB retained delta or **any** detached DOM nodes raises a finding: severity `high`, confidence **`low`** — heap deltas are noisy, so this always needs verification (force GC, repeat the cycle N times, confirm monotonic growth). Detached-node counts come from CDP and are **Chromium-only**.

## Large JS chunk — `transferSizeBytes ≥ 400KB` (`BIG_JS_BYTES`)

From the network capture: any response with `resourceType === 'script'` and transfer size ≥ 400KB raises a `bundle` finding (top 3 per scenario), severity `medium`, confidence `high`. `renderBlocking` is recorded so you can tell an entry-chunk bloat problem from a lazy chunk. Fix per the route code-splitting rules in `fix-playbook.md`. For entry-vs-lazy attribution, run `bun scripts/analyze-bundle.ts` (produces the `BundleReport`).

## App-owned startup marks

The harness also captures the app's own `performance` marks from `src/lib/init-timing.ts` into `initTiming[]` (`InitTimingMark`: `name`, `startTime`). The useful ones:

- **`markAppMounted`** — first render of the root `App` component (offset from navigation start).
- **`app_chat_ready`** — first usable chat render (one-shot per session).

Use these to attribute a slow LCP/FCP to a specific startup phase — e.g. if `app_chat_ready` lands well after LCP, the paint is a skeleton and the real "ready" cost is later.

## Browser support caveats — read before trusting an empty array

The observers above are not uniformly supported. **An empty array is not the same as "no problem" — on Firefox it usually means "not measurable here."**

| Signal | Chromium | Firefox (Gecko) |
| --- | --- | --- |
| LCP, CLS, FCP, TTFB | ✅ | ⚠️ partial / may be absent |
| **LoAF** (`long-animation-frame`) | ✅ | ❌ **not supported — `loaf` is always empty** |
| **INP proxy** (`event` timing) | ✅ | ❌ **not supported — `inp` never populates** |
| `longtask` | ✅ | ❌ generally absent |
| Detached nodes / heap via CDP | ✅ | ❌ |

Consequences:

- **LoAF and the INP `event` proxy are Chromium-only.** On Firefox those arrays are empty; do **not** conclude "no long tasks on Firefox." Instead drive the same scenario under the **Gecko profiler** (`mcp__firefox-devtools__profiler_start` / `profiler_stop`) and read the captured samples — see `gecko-profiler.md`.
- Layout-thrash detection depends on LoAF, so it is **Chromium-only** too. A layout-thrash finding that only reproduces in Chromium is still real (same code runs in both) — verify it in Chromium, not by demanding a Firefox repro.
- A finding present in Chromium but "absent" in Firefox where the metric is unsupported is **not** a cross-browser discrepancy. `report.ts` merges the same issue across browsers by source attribution; don't down-rank a Chromium finding just because Firefox couldn't measure it.

See `react-rerender-playbook.md` for the render counter, `fix-playbook.md` for what to do per category, and `verification-rubric.md` for the precision gate that decides which candidates become confirmed.
