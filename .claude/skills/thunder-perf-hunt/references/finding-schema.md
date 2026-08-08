# Finding schema and run artifacts — the sub-agent contract

Every probe writes, and every sub-agent reads/writes, the compact structures
defined in `scripts/lib/types.ts`. The agentic layer reasons **only** over these
— never over raw traces. This doc is the canonical field reference and the
on-disk layout.

## `Finding` — a normalized, agent-facing issue

| field | type | meaning |
| --- | --- | --- |
| `id` | `string` | Stable slug, derived from category + attribution + scenario/browser. |
| `category` | `FindingCategory` | One of `web-vital`, `unnecessary-render`, `long-task`, `layout-thrash`, `memory-leak`, `bundle`, `network`, `console-error`, `crash`, `a11y`. |
| `title` | `string` | One-line human summary. |
| `severity` | `Severity` | `critical` \| `high` \| `medium` \| `low`. |
| `confidence` | `Confidence` | `high` \| `medium` \| `low` — how sure the deterministic layer is *before* the agent verifies. |
| `status` | `FindingStatus` | `candidate` → `confirmed` \| `refuted` → `fixed` \| `deferred`. |
| `browsers` | `BrowserName[]` | `chromium` and/or `firefox` the issue was seen in. |
| `scenarios` | `string[]` | Scenario name(s) it appeared in. |
| `evidence` | `string` | Compact quantitative evidence — the metric that triggered it (include numbers + units). |
| `sourceAttribution?` | `string` | `file:line` or a CSS selector the issue attributes to. |
| `repro` | `string` | Exact deterministic steps: which probe + scenario + browser (usually a `bun scripts/run.ts --mode focus …` command). |
| `beforeAfter?` | `{ metric, before, after, unit }` | Populated once a fix lands and the metric moves. |
| `suggestedFix?` | `string` | Pointer to a playbook or a one-line remedy. |
| `clusterId?` | `string` | Findings clustered for a single PR. |
| `prUrl?` | `string` | Set when a fix PR is opened. |

### Finding lifecycle

`candidate` (emitted by a probe / `report.ts`) → verified by a sub-agent →
`confirmed` (reproduced, with evidence) or `refuted` (couldn't reproduce, or
expected/by-design) → after a fix lands and the metric moves, `fixed`; real but
out-of-scope issues are `deferred`.

## `VerdictReport` — what a verifier sub-agent returns

A verifier re-runs the focused scenario and returns this (not prose), so the
orchestrator can merge verdicts deterministically:

| field | type | meaning |
| --- | --- | --- |
| `findingId` | `string` | The `Finding.id` under test. |
| `reproduced` | `boolean` | Did the re-run reproduce the signal? |
| `isReal` | `boolean` | Is it a genuine defect (vs. expected/by-design)? |
| `rationale` | `string` | Why confirmed or refuted, citing the re-run evidence. |
| `correctedSeverity?` | `Severity` | Override if the first-pass severity was wrong. |
| `sourceAttribution?` | `string` | Refined `file:line`/selector found during verification. |

## Run artifacts layout

`run.ts` writes one directory per run under `.perf-hunt/runs/<runId>/`
(`runId` defaults to an ISO timestamp with `:`/`.` replaced by `-`):

```
.perf-hunt/runs/<runId>/
├── report.json        # the RunReport: runId, gitRef, mode, scenarios[], bundle?
├── findings.json      # Finding[] derived by report.ts (deriveCandidates → merge)
├── summary.md         # human-readable ranked summary (report.ts summarize())
├── <scenario>.<browser>.png   # per-scenario screenshot (e.g. chat-landing.chromium.png)
└── explore/           # explorer output: per-state screenshots + its findings
```

- **`report.json`** conforms to `RunReport` — the raw structured measurements
  (`ScenarioReport[]`, optional `BundleReport`). Written by `run.ts`.
- **`findings.json`** is `Finding[]` — the thresholded, cross-browser-merged
  candidates. Written by `report.ts` (`deriveCandidates`). **This is the file
  verifier sub-agents read and the fix agent updates** (setting `status`,
  `beforeAfter`, `prUrl`).
- **`summary.md`** is the ranked, emoji-tagged digest for humans.
- **`*.png`** are evidence screenshots referenced by `ScenarioReport.screenshotPath`
  and by findings.
- **`explore/`** holds the crawler's per-state screenshots and functional-bug
  findings (see [state-exploration.md](state-exploration.md)).

Re-summarize an existing run without re-driving the browsers:

```bash
bun scripts/report.ts .perf-hunt/runs/<runId>/report.json
```

Keep this contract stable — the probes, the report aggregator, the verifier
sub-agents, and the fix/PR templates ([../assets/finding-template.md](../assets/finding-template.md),
[../assets/pr-template.md](../assets/pr-template.md)) all depend on it.
