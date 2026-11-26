# Live hunt

Only when the user asks to attack a running system. **A separate track from the sweep, with two
jobs: discovery** (surfacing NEW hypotheses reasoning missed) and **confirming the un-speccable
set**. It is not a higher tier every finding must pass: a passing spec (L2) already is the
confirmation, and a **failed live hunt never refutes a finding** (the agent may just have failed to
reach the adversary's position). The Rails in `SKILL.md` apply throughout.

**Adversary-dependent.** For `A2` (compelled server, the headline adversary) the position is the
wire + the DB, so a spec's response-rewriting + Postgres access is already the faithful
reproduction and a browser-only hunt adds little. For `A5`/`A6` (stolen session, in-origin script)
the attacker *is* a browser/endpoint client, so live is the right tool. The live "sandbox" is the
**scratch-spec loop** (`e2e/e2ee/attacks/scratch/`, gitignored), which drives a real browser *with*
the pack's adversary primitives and oracles.

```bash
bash scripts/run-e2ee-powersync.sh    # Postgres + PowerSync on 5434/8081
```

Then drive real browsers with Playwright while holding direct Postgres access: you are playing the
**compelled server**, not an internet attacker. That position is the only way to test `C1`
honestly.

**Oracles** (`e2e/e2ee/oracles.ts`) are the verdict functions. Call them rather than eyeballing
output; they are the whole reason a live run can check itself:

- `expectNoPlaintextOnServer(markers)` / `scanServerForPlaintext(markers)`: C1, targeted
- `expectAllColumnsCiphertext(userId)` / `findUnencryptedValues(userId)`: C1, blanket
- `expectEncryptedColumnsMapMatchesSchema()`: fails if the map drifted from the schema
- `serverAuthoredPlaintextColumns`: the documented divergences the blanket scan skips

**Adversary primitives** (`e2e/e2ee/db.ts`) impersonate a malicious server directly against
Postgres: `readCell`, `writeCell`, `swapCells` over a `CellRef` of `{ table, rowId, column }`.

**Adversary contexts** (`e2e/e2ee/helpers.ts`): `trustAdditionalDevice`, `revokedDeviceContext`
(A4, keeps its cached keys), `stolenSessionContext` (A5, session, no keys), `serveEvilOrgKey`
(A2/A8, serves a substituted escrow public key in the browser; exercised by
`attacks/org-key-substitution.spec.ts`), plus `createIsolatedDevice`, `revokeTrustedDevice`,
`signOutKeepingData`, `getEncryptionKeyNames`, `deviceLabels`.

`attacks/primitives.spec.ts` is the toolkit's own self-test: read it first to see each primitive
used once.

Throwaway attempts go in `e2e/e2ee/attacks/scratch/`. **Every confirmed break becomes a permanent
spec** at `e2e/e2ee/attacks/<name>.spec.ts`, named for the claim it defends, through
[`reproduce.md`](reproduce.md); from then on it gates every PR.

**Honest-backend caveat.** The harness backend is HONEST: it enforces server-side backstops a
modeled `A2` would simply skip (e.g. `PLAINTEXT_UPLOAD_REJECTED` when the stored
`scheme_version === 2`, `backend/src/api/powersync.ts`). When an `A2` finding is a CLIENT fail-open,
assert on the client's OUTPUT (intercept the outbound request and inspect its payload), not on
server-at-rest state, or the honest backstop masks the break and the spec reads as falsely refuted.
Reserve the DB-at-rest oracles for breaks the client actually lets through end to end.
