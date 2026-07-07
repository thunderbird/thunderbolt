---
name: thunder-perf-hunt
description: >-
  Drives headless Chromium AND Firefox against a locally-booted Thunderbolt to
  hunt performance bottlenecks (Core Web Vitals, unnecessary React re-renders,
  long tasks, layout thrash, memory leaks, bundle bloat), functional bugs, and
  a11y violations — then adversarially verifies each finding and autonomously
  opens one small PR per fix or tight cluster. Use when the user says
  perf-hunt, performance audit, "find slow/janky UI", "why is it re-rendering",
  "hunt for bugs in the browser", "profile the app", or asks to speed up /
  fix perf regressions. Boots its own Docker-free stack (pglite + anonymous
  auth); never touches production.
---

# Thunder Perf Hunt

A two-layer harness. **Layer 1 (deterministic)** = Bun + Playwright probe scripts
that boot the app and emit compact JSON — real, reproducible numbers, no LLM
guessing. **Layer 2 (agentic, this document)** = a Scout → Triage → **adversarial
Verify** → Fix → PR pipeline modeled on Anthropic's security-review harness
(separate discovery from verification; verify by reproduction; a good harness
makes iteration cheap). You read only the JSON, never raw traces.

## Operating rules (low freedom — always)

- **The deterministic layer owns the numbers; you own attribution, verification, and fixes.** Never eyeball a screenshot and declare a metric — run the probe and cite its output.
- **Separate finding from dismissing.** The agent that fixes must not be the one that verified a finding is real. Verification is adversarial: default to *refuted* unless reproduced AND attributed to a source location. See `references/verification-rubric.md`.
- **Warm before you measure.** Vite transpiles a route on first hit; a cold first navigation is not a real metric. Every scenario is warmed once before the measured pass (the probes handle this; never bypass it).
- **Fixes are architectural, never band-aids** (CLAUDE.md core principle). Follow the repo's React/`useEffect` discipline and route code-splitting rules. Soft-delete only; never hard-delete.
- **Every fix carries a before/after number** from re-running the exact focus probe. No number → not a fix.
- **One concern per PR.** One branch + PR per fix or tightly-related cluster, kept small for easy review (the user's explicit goal).
- **Prove-then-commit.** Run `thundercheck` (types/lint/format) green before any PR. Use `/thunderpush` for all git — never manual `git add/commit/push`.
- **Do not fix exclusion-category noise** (StrictMode double-render, streaming re-renders, third-party/analytics long tasks, dev-only warnings). Auto-refute them — see the rubric.

## Prerequisites (one-time)

```bash
# From repo root. Browsers are ~700MB; only needed once.
# NOTE: run the Playwright CLI through `bun`, NOT `bunx playwright` — this repo is
# bun-only (no `node`), and the playwright bin has a `#!/usr/bin/env node` shebang
# that fails with "env: node: No such file or directory".
bun node_modules/playwright-core/cli.js install chromium firefox

# On a very new OS where Playwright has no prebuilt browser (e.g. the install errors
# with "does not support chromium on ubuntuXX.YY-arch"), download the nearest
# supported build via the platform override — it runs fine on the newer glibc:
PLAYWRIGHT_HOST_PLATFORM_OVERRIDE=ubuntu24.04-arm64 bun node_modules/playwright-core/cli.js install chromium firefox

# A 32+ char BETTER_AUTH_SECRET must be exported (backend/.env has one, or `make doctor` generates it).
# An AI provider key (ANTHROPIC_API_KEY) is only needed for scenarios that send a chat message.
```

If Playwright browsers cannot be installed at all on the host, the **Firefox path still works** via the `firefox-devtools` MCP + system Firefox (Marionette) — see `references/gecko-profiler.md`. Chromium-only metrics (LoAF, CDP heap) are unavailable in that fallback.

The harness boots its own stack on dedicated ports (frontend :1431, backend :8010, pglite, anonymous auto-session) — it will not collide with `make dev` (:1420/:8000) or the e2e suite. It reuses an already-serving stack if one is up.

## Inputs & modes

Pick the narrowest mode that answers the question:

| Mode | Command | When |
| --- | --- | --- |
| `diff` (default on a branch) | `bun scripts/run.ts --mode diff --changed <files>` | Reviewing a PR/branch — probes only the scenarios that exercise changed files. Fast + cheap. |
| `focus` | `bun scripts/run.ts --mode focus --focus chat-landing` | Deep-dive one surface, or re-measure after a fix (before/after). |
| `sweep` | `bun scripts/run.ts --mode sweep` | Full audit across all scenarios × both browsers. |

Scripts live in `scripts/` under this skill dir; run them from the repo root with the skill path, e.g. `bun .claude/skills/thunder-perf-hunt/scripts/run.ts ...`.

## Workflow (follow in order — copy this checklist)

### 1. SETUP
- Ensure browsers installed (`bunx playwright install chromium firefox` if `~/.cache/ms-playwright` lacks them).
- Choose mode. On a branch/PR: `diff` using the changed files (`git diff --name-only main...HEAD`). On explicit "audit everything": `sweep`. For a single surface or a re-measure: `focus`.
- Choose browsers: default both (`chromium,firefox`); Chromium-only for a quick pass.

### 2. SCOUT (recall pass — run the probes)
Run the lenses the request needs (all of them for a full hunt):
- **Perf + a11y + console/crash:** `bun scripts/run.ts --mode <mode> [flags]` → prints the `report.json` path. Then `bun scripts/report.ts <report.json>` → writes `findings.json` + `summary.md` (recall-biased candidates with thresholds already applied).
- **Bug/exploration lens:** `bun scripts/explore.ts [--browsers chromium] [--steps 40]` → curiosity-driven state-graph crawl → `explore/explore-findings.json` (crashes, console errors, dead-ends) + per-state screenshots. See `references/state-exploration.md`.
- **Bundle lens:** `bun scripts/analyze-bundle.ts` → `bundle-report.json` (entry-chunk + largest chunks vs size-limit budgets).
- **Firefox-deep lens (only if a finding is Firefox-only or Firefox-specific jank is suspected):** drive the Gecko profiler over the `firefox-devtools` MCP — see `references/gecko-profiler.md`. LoAF/CDP source attribution is Chromium-only, so this is how Firefox jank gets attributed.

Read `summary.md` + the findings JSONs — never the raw traces. That is the whole candidate set.

### 3. TRIAGE
- Merge duplicates (the report already merges the same issue across browsers). Cluster related findings that would share a fix (`clusterId`).
- Drop exclusion-category noise per `references/verification-rubric.md`.
- Rank by severity × confidence. Carry forward the top findings; note (don't silently drop) anything cut for volume.

### 4. VERIFY (precision pass — adversarial, parallel sub-agents)
For each surviving finding, dispatch a **separate verifier sub-agent** (see execution model). The verifier:
- Re-runs the exact `focus` probe (or Gecko profile for Firefox) to **reproduce** the number.
- **Attributes to a source location** (`file:line` or component) — reading the LoAF `sourceURL:charPosition`, the render component name, the a11y selector, the crash stack.
- Tries to **refute** it (is it expected? third-party? cold-cache artifact? StrictMode?). Returns a structured `VerdictReport` (`reproduced`, `isReal`, `rationale`, `sourceAttribution`, `correctedSeverity`).
- For ambiguous perf findings, use a **2-of-3 vote**.
Only `confirmed` findings with a source attribution proceed.

### 5. FIX (per confirmed cluster)
For each cluster, in its own git branch:
- Consult `references/fix-playbook.md` (+ `react-rerender-playbook.md` for renders) and implement the **architectural** fix, obeying CLAUDE.md React/`useEffect`/code-splitting rules.
- Re-run `focus` on the affected scenario(s) in the affected browser(s): capture the **before** (from the original run) and **after** numbers. If the metric didn't move, the fix is wrong — iterate.
- **Hard cap: 3–5 fix↔measure iterations**, then stop and escalate the finding as `deferred` with notes (per `references/harness-tuning.md`).
- Run `thundercheck` until green.

### 6. PR (autonomous — one per cluster)
- Use `/thunderpush` to branch/commit/push, then open a PR (via `/thunderpush`'s PR flow or `gh pr create`). One PR per cluster.
- PR body from `assets/pr-template.md`: what was wrong, the fix, a **BEFORE/AFTER metric table**, how it was verified (probe/scenario/browser), reviewer checklist.
- Fully autonomous per project config — no pause. Keep each PR single-concern so review stays trivial.

### 7. REPORT
Emit a concise summary to the user: findings by severity, which were confirmed vs refuted (with the false-positive reasons — this is signal), the PRs opened with links, and the before/after table per fix. Link the run dir (`.perf-hunt/runs/<runId>/`).

### 8. REFLECT (self-improve — bounded)
Make the harness a little better using signals from THIS run — but only in ways that add signal, never complexity. Read `references/self-improve.md` and follow it exactly. In short:
- Read the run signals (probe errors/empty outputs, scenario timeouts, verifier-confirmed false positives, crawler-discovered routes, attribution gaps, cost).
- **Auto-apply at most 3 SAFE changes:** suppress a confirmed false positive (`calibration.json` `excludeSignatures`, with a reason), add a discovered route (`calibration.json` `extraScenarios`), fix a broken probe, or tune one threshold by one step (only with ≥2-run evidence).
- **Propose-only** (log to `LEARNINGS.md`, do NOT apply): anything that adds a dependency, abstraction, file, probe type, or cost.
- **Guardrails:** after any self-edit, `bunx tsc -p scripts/tsconfig.json` must pass AND one `focus` smoke run must succeed, or revert. Harness self-edits go in their OWN PR titled `perf-hunt: self-improve (<date>)`, never mixed with app-fix PRs. Always append a dated entry to `LEARNINGS.md` (even "no improvements warranted"). The harness should trend toward FEWER moving parts.

## Execution model — lens + finding fan-out (for recall and precision)

- **Scout fan-out:** run the lenses (perf, explore, bundle) concurrently — they're independent scripts. On a full sweep, you may also fan out scenarios across sub-agents, but prefer one `run.ts` invocation (it already loops browsers×scenarios in one warm stack — cheaper than N cold boots).
- **Verify fan-out:** one verifier sub-agent per finding (or per 2–3 clustered findings), in parallel. Each gets ONLY: the one finding's JSON, the repro command, and the rubric. It returns a `VerdictReport` — structured, not prose. This is the precision gate; do not skip it to save time.
- **Fix fan-out:** fixes that touch disjoint files may run in parallel sub-agents (use worktree isolation if they'd otherwise conflict). Fixes to the same file are serialized.

Keep sub-agent context minimal (compact JSON in, structured verdict out) — this is what keeps the harness itself cheap. See `references/harness-tuning.md`.

## Severity & confidence

- **Severity:** `critical` (crash/data-loss/broken core flow), `high` (poor Web Vital on the critical chat surface, >300ms task, confirmed leak), `medium` (needs-improvement vital, noisy re-renders, large chunk), `low` (minor).
- **Confidence:** `high` (deterministic + reproduced + attributed), `medium` (reproduced, attribution partial), `low` (single sample / heuristic). Full ladder + exclusion categories in `references/verification-rubric.md`.

## Reference files (read on demand — progressive disclosure)

- `references/metrics-and-thresholds.md` — every metric, its threshold, how it's captured, browser-support caveats. Read in SCOUT/TRIAGE.
- `references/react-rerender-playbook.md` — how render counting works + the noise-render probe + re-render fix catalog. Read for `unnecessary-render` findings.
- `references/fix-playbook.md` — architectural fixes per finding category. Read in FIX.
- `references/verification-rubric.md` — the adversarial verify protocol, exclusion categories, severity/confidence ladder. Read in VERIFY (mandatory).
- `references/state-exploration.md` — the curiosity-driven crawler + visual diffing. Read for the bug lens.
- `references/a11y-checks.md` — axe rules + fixes. Read for `a11y` findings.
- `references/gecko-profiler.md` — driving the Firefox Gecko profiler over the MCP. Read for Firefox-deep analysis.
- `references/harness-tuning.md` — keeping the harness itself fast/cheap; diff mode, caps, cost knobs. Read when a run is slow/expensive.
- `references/self-improve.md` — the REFLECT protocol: what may be auto-applied vs proposed, and the anti-complexity guardrails. Read in REFLECT (mandatory). Learnings accumulate in `calibration.json` (data) + `LEARNINGS.md` (log).
- `references/finding-schema.md` — `Finding`/`VerdictReport` schema + run-artifact layout. The sub-agent contract.
- `assets/finding-template.md`, `assets/pr-template.md` — fill-in templates.
