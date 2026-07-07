# Harness tuning — making the skill itself cheap

> **Research finding: harness quality dominates agent effectiveness.** A good
> harness makes iteration cheap — the agent spends its budget reasoning about
> *findings*, not wrangling tools or re-reading traces. Every knob below exists
> to keep the harness's own wall-clock and token cost low without losing recall.

This doc is about the cost of *running the skill*, not the cost of the app under
test. Tune these before reaching for more scenarios or more browsers.

## (a) Do less work per run

**Diff-aware selection (`--mode diff`).** On a branch or in CI, default to diff
mode. `scenariosForChangedFiles` (`scripts/lib/scenarios.ts`) maps changed
files → only the scenarios that exercise them via coverage `tags`, falling back
to the full sweep only when the blast radius is unknown. A one-file change to
`src/models/*` runs the `models` scenario, not all seven.

```bash
bun scripts/run.ts --mode diff --changed "$(git diff --name-only main... | paste -sd,)"
```

**Warm-stack reuse.** `bootStack` (`scripts/lib/boot.ts`) checks whether the
backend health endpoint and frontend are already serving on `:8010`/`:1431`; if
so it reuses them and its `teardown` is a no-op. Keep a stack warm across a
verify-fix loop instead of paying the ~cold-boot cost (backend + Vite) every
iteration.

## (b) Deterministic layer keeps context small

The scripts are the *deterministic layer*: they boot, drive, measure, threshold,
and write compact JSON. **The agent reads only `findings.json` / `summary.md`
— never raw traces, never probe stdout beyond the one printed report path**
(`run.ts` prints exactly the report path to stdout by design). Every probe
reduces its raw signal (LoAF scripts, axe violations, heap deltas, sampled
stacks) to the compact structures in `scripts/lib/types.ts` before the agent
sees anything. This is the single biggest token lever — protect it. If you find
yourself piping a trace into the model, add a threshold to `report.ts` instead.

## (c) Sub-agent orchestration

- **Parallelize verification.** Fan candidate findings out to verifier
  sub-agents (one per finding or per cluster) that each re-run the focused
  scenario and return a **structured `VerdictReport`, not prose** (see
  [finding-schema.md](finding-schema.md)). Structured returns keep the parent's
  context flat and let it merge verdicts deterministically.
- **Isolate the heavy tools.** A sub-agent that drives the Gecko profiler
  ([gecko-profiler.md](gecko-profiler.md)) or the explorer
  ([state-exploration.md](state-exploration.md)) keeps that tool's chatter out
  of the orchestrator's context; only the verdict returns.

## (d) Hard caps (non-negotiable)

| Cap | Limit | Why |
| --- | --- | --- |
| Verify-fix loop | **3–5 iterations**, then escalate to a human | Prevents infinite "fix → still fails → fix" spins. |
| Scenarios per run | the 7 in `SCENARIOS` (fewer in diff mode) | Bounds the sweep. |
| Explored states | **~60** (`--steps` to raise) | Bounds the crawl. |
| Findings promoted per category | capped in `report.ts` (e.g. long tasks `.slice(0,3)`, a11y `.slice(0,8)`, network `.slice(0,3)`) | Stops one noisy page from flooding triage. |

If a fix hasn't landed the metric after the loop cap, stop and hand the finding
back with its evidence — don't keep burning iterations.

## (e) Cost knobs

Turn these down for a quick run, up for a thorough nightly:

- **Browsers** — `--browsers chromium` halves the sweep. Reserve
  `chromium,firefox` for the full sweep or when a finding needs cross-engine
  confirmation.
- **Mode** — `focus` (one named scenario) < `diff` (changed-file scenarios) <
  `sweep` (all). Use `--mode focus --focus <name>` when re-checking a single
  fix.
- **Skip the expensive probes for quick runs** — skip the heap delta
  (Chromium-only re-navigation, the slowest probe) and skip the explorer crawl.
  Reserve both for full sweeps.

## (f) Measure the harness itself

Treat the harness like any system under test. After each run, record:

- **Wall-clock** — total and per-phase (boot vs. drive vs. verify).
- **Tokens** — orchestrator + sub-agents.
- **Findings count** and **false-positive rate** — refuted / total from the
  `VerdictReport`s.

Then tune the `report.ts` thresholds (`LONG_TASK_MS`, `LOAF_MS`,
`FORCED_LAYOUT_MS`, `HEAP_LEAK_BYTES`, `NOISE_RENDER_MIN_COMMITS`,
`BIG_JS_BYTES`): a high false-positive rate means a threshold is too loose
(raise it); missed regressions mean it's too tight (lower it). The thresholds
are deliberately recall-biased — the Verify phase pays for precision, so keep
tightening only until false positives, not real bugs, drop out.
