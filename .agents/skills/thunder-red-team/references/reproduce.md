# Reproduce (L1 → L2)

The post-reasoning phase: promote an operator-greenlit L1 finding to **executed proof**. One finding
at a time. The Rails in `SKILL.md` apply throughout.

1. **Speccability call.** Can this be a deterministic spec? If not (timing, multi-tab, manual
   interaction), flag it **"L1 only — not reproducible in harness"** with the reason and stop; it is
   reported at L1 and its ticket says so. An un-speccable finding stays L1; a flaky spec is worse
   than none.
2. **Write the spec** at `e2e/e2ee/attacks/<name>.spec.ts`, named for the claim it defends. Assert
   the **secure** behavior (the exploit must NOT succeed, e.g. "no plaintext on the wire") and tag it
   `test.fail()` while the vuln is open: the assertion fails today (the break is real), but the
   expected-failure marker keeps the suite **green** so it never blocks unrelated work, and the
   moment someone fixes the bug the assertion starts passing, Playwright flags the unexpected pass →
   **red**, forcing whoever fixed it to drop the tag and leave a permanent green regression gate.
   Always assert the secure behavior: the inverted "assert the exploit succeeds" form goes stale and
   relies on remembering to flip it. Iterate in `attacks/scratch/` (gitignored) first if it needs
   exploration. Exception: an **accepted residual** (a documented trade-off we've decided not to
   fix) is a plain green witness with **no** `test.fail()` tag, so it never becomes a forcing
   function; see the spec convention in `docs/internals/architecture/red-team-harness.md`.
3. **Capability audit (this is what makes L2 trustworthy).** The target (client + backend +
   crypto) stays **real and unmodified**; the harness only **simulates the adversary's
   environment**. List every privilege the spec uses (DB access, response rewrite, header forge, key
   read) and check each against the named adversary's row in the threat model. **Every privilege
   must be ⊆ that adversary's capabilities.** If the spec over-grants, using anything the adversary
   lacks, the finding is **NOT confirmed**; fix the spec or drop it. Mirror trap: our backend is
   honest and enforces backstops a real `A2` would skip, so for A2 *client*-fail-open findings
   assert on the client's OUTPUT (intercept the outbound request), not server-at-rest state (see the
   honest-backend caveat in [`live-hunt.md`](live-hunt.md)).
4. **Run** in isolation, then the full e2ee suite (load-dependent flakes). Passing = **L2**.
5. **Checkpoint 2**: present the spec for review before any commit.
6. **Record** the confirmed finding in the ledger (`.red-team/`) and draft its Linear ticket
   (draft-before-create) tagged **L2** with the spec path. Remediation happens later on the fix
   branch, never on this test branch: the fix makes the `test.fail()` spec pass, and dropping the
   tag (L∞) turns it into a permanent regression gate.
