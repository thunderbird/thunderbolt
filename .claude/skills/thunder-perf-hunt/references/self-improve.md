# Self-improvement (the REFLECT phase)

After every run, the harness spends a little effort making itself measurably better — but **only in ways that add signal, never complexity**. Harness quality dominates agent effectiveness, so a cheap, well-calibrated harness compounds; a bloated one rots. This doc is the contract for that.

> Guiding rule: **prefer deleting or tuning over adding.** If an "improvement" needs a new dependency, a new abstraction, or a new file, it is a *proposal*, not an auto-change.

## When it runs

REFLECT is step 8 of the workflow — after REPORT, using signals from the run just completed and the log in `../LEARNINGS.md`.

## Signals to read (evidence, not vibes)

| Signal | Where it shows up | What it usually means |
| --- | --- | --- |
| Probe errored / returned empty when it shouldn't | probe stderr, empty arrays in `report.json` | a harness bug (bad selector, wrong wait, gated metric) |
| Scenario failed to load / timed out | `pageErrors`, missing metrics for a scenario | stale selector or a route that moved |
| Verifier refuted a finding as a false positive | `VerdictReport.isReal=false` with a repeatable reason | a threshold or exclusion needs tuning |
| Crawler reached a route not in the manifest | `explore/state-graph.json` vs `scenarios.ts` | a coverage gap |
| Finding had no source attribution | `sourceAttribution` empty on a confirmed finding | attribution logic gap |
| Run slow / expensive | wall-clock, token count | a cost knob to pull (see harness-tuning.md) |

## What may be applied automatically (SAFE-AUTO)

Cap: **at most 3 auto-applied changes per run.** Each must cite the run evidence.

1. **Suppress a confirmed false positive** — append an `excludeSignatures` entry to `../calibration.json` (with a `reason`). Only after a verifier confirmed it's benign/expected.
2. **Add a discovered route** — append an `extraScenarios` entry to `../calibration.json` (name/path/description/tags). It gets a default load+settle probe.
3. **Fix a broken probe** — a targeted code fix when a probe errored or returned empty due to a bug (e.g. a selector/wait/flag). This is a normal bug fix, not a feature.
4. **Tune one numeric threshold** in `report.ts` by at most one sensible step — only when the SAME false-positive or miss pattern appears in **≥2 runs** (check `../LEARNINGS.md`).

## What must only be proposed (PROPOSE-ONLY — log, do not apply)

- Any new probe type, dependency, abstraction, or net-new file.
- Threshold changes beyond one step, or without ≥2-run evidence.
- Anything that increases run cost or scenario count materially.
- New scenario *interactions* that need real code (JSON can't hold functions) — propose a `BASE_SCENARIOS` edit for human review.

Write proposals to `../LEARNINGS.md` under "Proposed". If the same proposal recurs across two runs, escalate it to the user instead of letting it accumulate.

## Guardrails (non-negotiable)

- **Green-or-revert:** after any self-edit, `bunx tsc -p scripts/tsconfig.json` must pass AND one `focus` smoke run must succeed. If not, revert the edit.
- **Separate PR:** harness self-improvements go in their own branch/PR titled `perf-hunt: self-improve (<date>)`. Never mix them with app-fix PRs.
- **Always log:** append a dated entry to `../LEARNINGS.md` every run — what changed, what was proposed, and why — even if nothing changed ("no improvements warranted" is a valid entry).
- **Complexity budget:** the harness should trend toward *fewer* moving parts. If a run's proposals only add surface area, apply none and note it.

## calibration.json schema

```jsonc
{
  "excludeSignatures": [
    { "category": "console-error", "match": "ResizeObserver loop limit", "reason": "benign browser warning, not our code" }
  ],
  "extraScenarios": [
    { "name": "skills", "path": "/skills", "description": "Skills admin page (crawler-discovered)", "tags": ["settings", "lazy"] }
  ]
}
```

`match` is a case-insensitive substring tested against each finding's title + evidence + source. `category` is optional (omit to match any). Both arrays are read at run time by `report.ts` and `scenarios.ts`; a missing/invalid file falls back to built-in defaults.
