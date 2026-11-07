# Verification rubric

The precision gate. `report.ts` thresholds are **recall-biased** — they deliberately over-emit candidates. This phase is what makes the harness trustworthy. It is modeled on Anthropic's security-review harness, where a separate adversarial verification pass cut false positives from ~33% to ~7%. The same discipline applies here.

Output of this phase: a `VerdictReport` per candidate finding (shape below), flipping each `Finding.status` from `candidate` to `confirmed`, `refuted`, or `deferred`.

## Hard rules

1. **The verifier MUST be a separate agent from the finder.** Whoever produced or triaged the candidate does not also judge it. Combining find + dismiss causes self-censoring (the finder rationalizes its own noise, or defends its own weak signal). Spawn a fresh verifier agent per finding or per cluster.
2. **Reproduce before believing.** The verifier must **re-run the exact probe/scenario/browser** from the finding's `repro` string and observe the metric again. A finding that cannot be reproduced on a warm route is `refuted`. No reproduction, no confirmation — never confirm from the candidate text alone.
3. **Default to `refuted`.** Confirm only when the verifier can BOTH (a) reproduce the signal AND (b) attribute it to a specific source location (`file:line`, LoAF `sourceURL:sourceCharPosition`, or a CSS selector). Reproduced-but-unattributed → stays a candidate or is `deferred`, not `confirmed`.
4. **2-of-3 vote for ambiguous perf findings.** For low-confidence or noisy categories (memory-leak, and any medium-confidence render/long-task finding), run the probe **three times** and require the signal in **at least two** runs. Perf metrics are noisy; a one-off spike is not a finding.

## Auto-refuted exclusion categories (false positives by construction)

These reproduce as signals but are **not** bugs in our code. The verifier marks them `refuted` (or `deferred` if real-but-out-of-scope) without further work:

| Exclusion | Why it's not a finding |
| --- | --- |
| **StrictMode double-render in dev** | React intentionally double-invokes render/effects in dev StrictMode. Extra commits from this are expected — not an unnecessary-render bug. |
| **Re-renders during active AI streaming** | Streaming a chat response legitimately commits many times as tokens arrive. High commit counts *during streaming* are expected; only judge renders during genuinely idle/no-op interactions (the noise probe). |
| **Third-party / analytics long tasks** | Long tasks / LoAF attributed to PostHog and other third-party scripts are not our code to fix. Refute (or `deferred` with a note) — do not open a PR against vendor code. |
| **Dev-only console warnings** | Warnings that only appear in the dev build (Vite HMR, React dev warnings that aren't real errors) are not shipped. `console-error` findings must be real runtime errors. |
| **Cold dev-server first-compile metrics** | Vite transpiles a route on first hit, so the first navigation is artificially slow (long tasks, bad FCP/LCP, big "network" for uncached transforms). **Always warm the route once before measuring.** A metric seen only on the cold first hit is `refuted`. |
| **`localhost` TTFB** | TTFB against the local dev server is meaningless; refute unless reproduced against a prod-like build. |

If a candidate falls into one of these, cite the exclusion in the `rationale` and move on.

## Severity ladder

Set/correct severity based on **user-visible impact**, not raw magnitude. Use `correctedSeverity` when the deterministic pass over- or under-rated it.

| Severity | Meaning | Example |
| --- | --- | --- |
| `critical` | Breaks the app or blocks core use | Uncaught error crashing chat; unusable interaction |
| `high` | Clearly degrades UX on a common path | LCP `poor` on landing; LoAF ≥400ms during send; component commits ≥8x on a no-op; confirmed multi-MB leak |
| `medium` | Noticeable but tolerable / off-path | INP `needs-improvement`; 3–7x noise renders; 400KB lazy chunk; serious a11y on a secondary page |
| `low` | Minor / edge | Vital just over `good`; single small extra render |

## Confidence ladder

| Confidence | Meaning | Example |
| --- | --- | --- |
| `high` | Deterministic, attributed, reproduced every run | Web vital rating; LoAF with a clear `sourceURL`; axe violation with selector |
| `medium` | Reproduces but attribution is coarse or interaction-dependent | `longtask` (container-only attribution); noise-render candidate before react-scan confirms the cause |
| `low` | Noisy signal, needs the 2-of-3 vote | Heap delta; anything that varies run to run |

Do not confirm a `low`-confidence finding without either raising it to `medium`+ via reproduction/attribution or clearing the 2-of-3 vote.

## The `VerdictReport` the verifier returns

Exactly this shape (from `scripts/lib/types.ts`):

```ts
type VerdictReport = {
  findingId: string
  reproduced: boolean          // did re-running the probe show the signal again?
  isReal: boolean              // true → confirm; false → refute (incl. exclusions)
  rationale: string            // cite the re-run evidence or the exclusion
  correctedSeverity?: Severity // when the candidate was mis-rated
  sourceAttribution?: string   // the file:line / selector the verifier pinned it to
}
```

Mapping to `Finding.status`:

- `reproduced && isReal` + attribution → `confirmed` (proceed to `fix-playbook.md`).
- `!reproduced` OR matches an exclusion → `refuted`.
- Real and reproduced but **out of scope** for autonomous fixing (vendor code, needs product decision, large refactor) → `deferred`, with the reason in `rationale`.

`rationale` must cite the re-run — the metric value seen, the run count for a voted finding, and the source location — or the specific exclusion. "Looks plausible" is not a rationale.

See `metrics-and-thresholds.md` for what each signal means and its browser-support caveats (empty Firefox arrays are not refutations — use the Gecko profiler), `react-rerender-playbook.md` for confirming render causes with react-scan, and `fix-playbook.md` for the fix once a finding is `confirmed`.
