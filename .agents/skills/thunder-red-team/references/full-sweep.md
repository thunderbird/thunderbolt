# Full sweep (`all`, or no argument)

The complete reasoning phase in one invocation, run as a **fan-out you orchestrate**: each of the
eight passes gets its own fresh-context subagent (see Harness notes in `SKILL.md`), because
reviewing the lenses inline in one context defeats the scoping. Four stages; **stages 2 and 3 are
part of every sweep**: the value of a sweep comes from refutation, which kills false positives and
recalibrates severities. A raw candidate dump is an unfinished sweep.

1. **Passes.** Spawn one read-only subagent per pass (`crypto`, `codec`, `backend`, `migration`,
   `lifecycle`, `escrow`, `sync`, `sweep`), in parallel, each with a FRESH context scoped to one
   pass and the **standard pass briefing** from `SKILL.md`. Then wait for all eight. A subagent that
   ends without its report has not reported "nothing found": resume or rerun it before proceeding.
   Done when eight reports are in hand.
2. **Triage** (a DEDICATED subagent, which keeps the dedup judgment out of your own context). It
   dedupes and clusters candidates across all eight by root cause, DROPS anything without a
   `file:line`, DROPS candidates the findings ledger (`.red-team/`) already records as
   confirmed/ticketed or refuted, and **surfaces convergence**: a candidate found independently by
   two or more passes is the strongest credibility signal, so rank those first. Done when it returns
   a deduped, ranked candidate list.
3. **Refutation.** Spawn one FRESH subagent per surviving candidate whose ONLY job is to prove it
   wrong. Refuter briefing:
   - Attack the FINDING, not the defense; hunt the guard that kills or downgrades it (caller check,
     DB constraint, type, middleware, runtime context).
   - **Reduce-to-known check:** read the threat-model "known & accepted" list,
     `.claude/security/fp-rules.txt`, the findings ledger (`.red-team/`), AND every already-ticketed
     finding; a candidate that reduces to any of them is REFUTED-as-known.
   - Recalibrate severity from preconditions (Rules of engagement §5 in `SKILL.md`).
   - Return a verdict ∈ {CONFIRMED, REFUTED, DOWNGRADED} with `file:line` reasoning.

   Done when every surviving candidate has a verdict.
4. **L1 report + handoff.** Synthesize survivors into the Output format in `SKILL.md` (confirmed /
   downgraded / refuted, each with its verdict reasoning), tag each survivor **L1**, and for each L1
   give a **speccability call** (can it become a deterministic attack spec, or is it un-speccable:
   timing, multi-tab, manual?) plus a recommended reproduction order. Then **STOP at Checkpoint 1.**
   The operator decides which findings advance to Reproduce (L1→L2), which are flagged L1-only, and
   which are skipped. A survivor stays **unconfirmed until an attack spec or a live hunt executes
   it**: reasoning plus refutation raises confidence; execution confirms it.

The sweep is reasoning-only (no stack). Live hunts stay **targeted and per-pass**
([`live-hunt.md`](live-hunt.md)); one stack serves one hunt, never eight booted stacks for a sweep.
