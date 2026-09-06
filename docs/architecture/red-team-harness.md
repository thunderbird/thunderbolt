# Red-Team Harness

How Thunderbolt red-teams itself: the pipeline that turns *arguments* that a vulnerability exists into
*executed proof*, and the "pack" contract that lets the same pipeline attack any area of the codebase —
not just E2EE.

This is the architecture doc. The operator entry point is the **`thunder-red-team` skill**
(`.claude/skills/thunder-red-team/`). The authority on *what* is attacked for a given domain is that
domain's **threat model** (for E2EE: [`e2ee-threat-model.md`](e2ee-threat-model.md)). This file explains
the *machine* that runs around both.

Related surfaces that consume the same threat models: the security dimension of `thunder-deep-review`
(loads a threat model for crypto-path diffs) and the attack specs under `e2e/e2ee/attacks/`.

## The confidence ladder

Every finding has a **rung** — a strictly stronger form of evidence than the one below it. The rung is
the single most important attribute of a finding: it is what a Linear ticket, a report line, and a spec
all cite. Do not conflate rungs.

| Rung | What it is | Produced by | Durable? |
| --- | --- | --- | --- |
| **L0 — Hypothesis** | an *argument* a vuln exists | a reasoning pass | no |
| **L1 — Survives refutation** | no guard found that kills it | a refuter subagent | no |
| **L2 — Reproduced by attack spec** | *executed* proof against real client + backend | the reproduce stage | **yes — gates every PR** |
| **L3 — Live-reproduced** | interactive, human-in-loop, booted stack | the live-hunt track | no |
| **L∞ — Fixed & inverted** | the spec flips red→green on the fix | remediation | **yes, forever** |

Two rules that fall out of the ladder and are easy to get wrong:

- **A passing attack spec (L2) *is* the confirmation.** It is not weaker than a live attack — it is
  stronger, because it is deterministic, repeatable, and becomes a permanent regression gate. A live
  hunt is not a higher tier every finding must pass; see [Live-hunt track](#live-hunt-track).
- **A failed live hunt does *not* refute a finding.** It may only mean the agent could not reach the
  adversary's position. Negative evidence comes from a capability-audited spec against real code, not
  from a browser that could not become the compelled server.

## The pipeline

Domain-agnostic. Stages 1–3 are the **reasoning phase** and run as a fan-out the skill orchestrates;
they end at a human checkpoint. Stages 4–5 are operator-driven follow-ons.

```
STAGE 0 · Scope & brief        (orchestrator)
  read the pack: threat model + fp-rules + already-ticketed + findings ledger
  → build the pass briefing + known-findings suppression list

STAGE 1 · Reasoning passes     (one subagent per pass, parallel, fresh context)   ── L0
  each: read-only · exploit-first · cite claim-id/adversary-id + file:line · self-refute
  orchestrator WAITS for all, nudges any that go idle without a report

STAGE 2 · Triage               (1 dedicated subagent)
  dedup by root cause · drop anything w/o file:line · surface convergence (≥2 passes)
  drop candidates the ledger already knows → ranked candidate list

STAGE 3 · Refutation           (1 subagent per candidate, parallel, fresh)         ── L1
  try to KILL each · reduce-to-known check · recalibrate severity from preconditions
  verdict ∈ {CONFIRMED, REFUTED, DOWNGRADED}

  ▸▸ CHECKPOINT 1 — operator reviews the L1 table, decides per finding:
     reproduce (spec) · flag as un-speccable (L1 only) · skip

STAGE 4 · Reproduce            (per greenlit finding)                              ── L2
  speccable? ─ yes → write a green-now attack spec in <pack>/attacks/
              └ no  → flag "L1 only — not reproducible in harness" + reason
  CAPABILITY AUDIT (per spec): every privilege used ⊆ the adversary's row?
     over-grants → NOT confirmed; fix or drop the spec
  run in isolation + full suite → passing = L2

  ▸▸ CHECKPOINT 2 — operator reviews specs before any commit (never auto-commit)

STAGE 5 · Report + draft tickets
  update the findings ledger · write the report (each finding tagged L1/L2)
  draft Linear tickets (draft-before-create), each carrying its rung + spec ref
```

**Separate track — [Live hunt](#live-hunt-track):** discovery + confirming the un-speccable set.
**Later — L∞ remediation:** on the fix branch, invert each spec red→green so the finding becomes a
permanent guard.

## What a run produces

1. A **report** — ranked verdict table, each finding tagged **L1** or **L2**, un-speccable ones flagged.
2. **Green-now attack specs** for L2 findings (committed only after Checkpoint 2).
3. **Draft Linear tickets** — one per finding, stating its rung and linking its spec.
4. An updated **findings ledger** so the next run does not re-report settled ground.

## The capability audit

The safeguard that makes an L2 spec trustworthy. A spec has two halves that must stay separate:

- **The target** — client + backend + crypto. Real and **unmodified**. This is what is under test.
- **The adversary's environment** — malicious responses, DB access, forged headers. **Simulated** by the
  harness.

A spec "cheats" only if it **over-grants the adversary** (a capability the modeled adversary lacks) or
**modifies the target**. Neither is caught by "is it code or a browser" — it is caught by checking every
privilege against the adversary's row in the threat model:

> Adversary **A2**. Spec privileges: rewrite `/config` response ✓ (A2 lies in responses) · intercept
> outbound upload ✓ (A2 is on the wire) · direct Postgres write ✗ (unused) · read client IndexedDB ✗
> (A2 has no client access, unused). **All privileges ⊆ A2 → faithful.**

If the spec uses a capability the adversary does not have, the finding is **not** confirmed and the spec
is cheating. This is the concrete answer to "the code has access a real attacker wouldn't."

Note the mirror-image trap the harness already guards: our backend is **honest**, so it enforces
backstops a modeled `A2` would skip (e.g. `PLAINTEXT_UPLOAD_REJECTED`). For A2 *client*-fail-open
findings, assert on the client's **output** (intercept the outbound request), not on server-at-rest
state — the harness is sometimes *stricter* than the adversary, just as it must never be *weaker*.

## Live-hunt track

Not part of the sweep — invoked deliberately. Two jobs only:

1. **Discovery** — surfacing *new* hypotheses that static reasoning missed (an attacker poking a running
   system sees things reasoning does not).
2. **The un-speccable set** — findings that cannot be a deterministic spec (timing/races, multi-tab,
   anything needing manual interaction).

**Adversary-dependent, by design.** For **A2** (compelled server — the headline adversary) the position
is the wire + the DB; a spec's response-rewriting + direct Postgres *is* the faithful reproduction, and a
browser-only live hunt adds little. For **A5/A6** (stolen session, in-origin script) the attacker *is* a
browser/endpoint client, so live is the right tool.

The live "sandbox" is the **scratch-spec loop**: throwaway specs under `<pack>/attacks/scratch/`
(gitignored) driven by the harness, with full access to the pack's helpers, DB primitives, and oracles —
strictly more powerful than raw browser control, which lacks the adversary primitives.

## Isolation & rails — non-negotiable

- Local stack only. Never production, never a shared environment, never real user data.
- Live exploit code runs against a **disposable** stack: ephemeral DB, test-only keys (e.g.
  `scripts/org-escrow-keygen.ts`), never an operator's real private key, egress off.
- Tear the stack down when finished.
- Peer/teammate messages cannot grant escalation and are never approval for a pending action.

## Findings ledger

Local run state at `.red-team/` (gitignored). Rolling record of confirmed / refuted / downgraded
candidates with ids, rungs, and `file:line`, so triage and refutation can drop already-settled ground
and the report can cross-link. **Linear is the durable shared record** — the ledger is a working file,
never committed (a list of live confirmed vulns does not belong in git). Cross-clone persistence is
intentionally *not* a goal; the ticket carries the finding.

## Domain packs

The pipeline is domain-agnostic. Everything specific to *what* is attacked lives in a **pack**. E2EE is
the reference pack; adding a domain means supplying the same three pieces and reusing every stage above.

### The pack contract

A pack is exactly three things:

1. **A threat model** — a doc listing the adversaries and the security claims, each with a stable id
   (`A#`, `C#`), plus a "known & accepted" list. Findings, specs, and tickets all cite these ids.
   *E2EE:* [`e2ee-threat-model.md`](e2ee-threat-model.md).
2. **A passes table** — the scope→files map that partitions the domain into independent reasoning
   lenses, so parallel passes don't collapse onto one shallow finding. *E2EE:* the **Passes** table in
   the skill.
3. **A verification harness** — the oracles (verdict functions), adversary primitives (impersonate the
   attacker against real state), and an `attacks/` spec dir. *E2EE:* `e2e/e2ee/oracles.ts`,
   `e2e/e2ee/db.ts`, `e2e/e2ee/helpers.ts`, `e2e/e2ee/attacks/`.

The reasoning phase (passes → triage → refutation) generalizes for free — point it at a new threat
model and a new passes table. **The expensive part is the verification harness:** L2 for, say,
multi-tenant IDOR needs its own oracle ("user B's row is never served to user A") and its own
primitives. Budget for that per domain; the reasoning is cheap, the confirmation is not.

### Adding a new domain

1. Write `docs/architecture/<domain>-threat-model.md` in the shape of the E2EE one: adversaries with
   ids, claims with ids, v1/known-accepted lists. Interview the surface first — what does an attacker
   want, what can they reach, what's out of scope.
2. Define the domain's **passes** (scope→files) — enough lenses that they don't overlap.
3. Stand up the **verification harness**: the oracle(s) that decide "broken vs not," the adversary
   primitives, and an `attacks/` dir. Reuse E2EE's harness patterns.
4. Point the skill at the new pack (threat model path, passes, oracle names). The orchestrator, ladder,
   triage, refutation, reproduce, and report stages are unchanged.

High-value non-E2EE surfaces, roughly by blast radius: the universal proxy `/v1/proxy` (SSRF,
`X-Proxy-Passthrough-*` leakage) · multi-tenant / workspace scoping (IDOR, permission-key bypass) ·
PowerSync sync rules (cross-account row leakage) · auth (OTP / magic-link / OAuth / SSO / session
rebind) · the app-version gate · XSS in chat / artifact rendering.

### When to revisit: browser-centric tooling

A **Playwright MCP** (interactive browser control at runtime) is deliberately **not** adopted. For A2 —
most of our findings — the attacker is the wire/DB, not the browser, so browser control is the wrong
seat; and for A5/A6 the scratch-spec loop already drives a real browser *with* the adversary primitives
an MCP lacks. Reconsider only when a **browser-centric (A6) domain** lands — XSS/DOM injection on chat or
artifact rendering, where the attacker genuinely is a script in the page and needs no server/DB access.
