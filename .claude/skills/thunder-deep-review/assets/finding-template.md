# Output Contract (exact format — low freedom)

Emit findings in this shape. Never post to the PR; return the report or write it to a review file only.

> **Recall pass — fix is optional.** This output feeds a downstream precision gate that filters candidates, so favor recall. Each finding must identify the issue with its evidence; a suggested fix is **optional**, included only when one is obvious. Never invent a fix just to fill the slot — a mandatory-fix step manufactures false positives.

**Voice:** write every finding for a **teammate**, not a linter — warm, collaborative, curious. Lead with a question or first-person framing where it fits ("I wonder if…", "Could we…?", "Heads up —"). Be specific and kind; never robotic, terse, or scolding.

**Rule/invariant ids are INTERNAL.** Cite a real `R-*`/`INV-*` id while grounding/keeping a finding (the verification bar + dedup use it), but it lives in the internal `rule` field — **never write rule-ids, section refs (`§`), or scaffolding (`INV-01`, `R-REDUCER`, "H mass-assignment…") into the human-facing problem/fix text.** They're meaningless to a person reading a PR comment.

## Header (always)
First line is a tally, then a one-line verdict:

```
Thunder Deep Review — <N> blocking, <N> convention, <N> nits
Verdict: PASS | CONCERNS | BLOCK
```
Lead with **"No blocking issues."** when there are none.

## Findings (grouped by severity: Blocking → Convention → Nits)
Each finding is one tight unit:

```
- `path:line` — <problem, in friendly register> [— <suggested fix, only if obvious>] (confidence: high|med|low)
```
(No rule-id in this line — it's human-facing; the id stays in the internal `rule` field. The fix clause is OPTIONAL — omit it when no fix is obvious.)

- Blocking findings: clear, warm statement; add the fix only when it's obvious.
- Convention findings: friendly and specific (the `R-*` id grounds it internally; don't show it).
- Medium/low confidence: phrase the problem as a question.
- Nit cap: at most 5 nits shown; if more, end the Nits group with `…plus <N> similar`.

Optionally add a collapsed rationale for non-obvious findings:
```
  <details>why: <one-line>; verification: quoted offending line</details>
```

## Machine-readable trailer (always last line)
For CI/orchestrator gating:

```
<!-- thunder-severity: {"blocking":<n>,"convention":<n>,"nit":<n>} -->
```

## Hard constraints
- Read-only. No Write/Edit, no PR posting, no deploy.
- Only changed lines. Pre-existing issues are context, never new blockers.
- Every finding cites a real `file:line` and (for convention/architecture) a real `R-*`/`INV-*` id, or it is dropped.
