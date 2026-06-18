# Output Contract (exact format — low freedom)

Emit findings in this shape. Never post to the PR; return the report or write it to a review file only.

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
- `path:line` — <problem, in-register> — <prescribed fix> [<RULE-ID or INV-ID>] (confidence: high|med|low)
```

- Blocking findings: direct statement + fix.
- Convention findings: terse, cite the `R-*` id.
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
