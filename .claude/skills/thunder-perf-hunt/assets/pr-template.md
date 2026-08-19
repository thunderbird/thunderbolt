<!--
PR body template for an autonomous perf-hunt fix PR.
Keep every PR SMALL and SINGLE-CONCERN: one fix, or one tight cluster of
findings that share a root cause (same clusterId). If two findings need
different fixes, open two PRs. Small single-concern PRs are the explicit goal —
they are fast to review and safe to revert.
Copy this file, replace every <placeholder>, delete guidance comments.
-->

## What was wrong

<1–3 sentences: the user-facing symptom + the finding(s) this PR closes. Link
the finding id(s) from findings.json. Include severity and which browser(s).>

- Finding: `<finding id>` (`<severity>`, `<category>`, `<browsers>`)
- Scenario: `<scenario name>`
- Source: `<file:line or selector>`

## The fix

<What changed and why it's the right architectural fix, not a workaround.
Keep the diff focused — call out anything intentionally left out of scope.>

## Before / after

| metric | before | after | unit | Δ |
| --- | --- | --- | --- | --- |
| <metric> | <before> | <after> | <ms \| KB \| commits \| MB \| count> | <-X% / -Xms> |

<One row per metric the fix moved. Numbers come from re-running the repro
command below on this branch vs. the baseline.>

## How it was verified

- **Probe / scenario / browser:** `bun scripts/run.ts --mode focus --focus <scenario> --browsers <browser>`
- **Verifier verdict:** `reproduced: false` on this branch (finding no longer
  fires) — the `VerdictReport` rationale confirms the metric moved below
  threshold.
- <Firefox-only fixes: note the Gecko-profiler re-capture — see
  ../references/gecko-profiler.md.>
- <Functional fixes: note the explorer no longer reaches the failing state.>

## Reviewer checklist

- [ ] Single concern — one fix or one tight cluster (shared root cause).
- [ ] Before/after numbers are real (re-run the repro command; not estimated).
- [ ] No new console errors, crashes, or a11y regressions in the focus run.
- [ ] Fix is architectural, not a workaround; follows house rules (no `any`,
      `useEffect` discipline, soft-deletes, route code-splitting where relevant).
- [ ] No unrelated files touched; diff stays reviewable.
- [ ] Finding(s) marked `fixed` in findings.json with `beforeAfter` populated.
