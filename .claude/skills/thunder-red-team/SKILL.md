---
name: thunder-red-team
description: >-
  Adversarial security review of Thunderbolt's end-to-end encryption. Attacks the
  security claims in docs/architecture/e2ee-threat-model.md rather than reviewing
  code for correctness, in two modes: a read-only reasoning pass over one scope,
  or a live hunt against a booted local stack. Use when asked to "red team",
  "attack the encryption", "try to break E2EE", "run a red-team pass", or to
  validate a claim like "the server cannot read user data".
---

# Red-teaming Thunderbolt E2EE

Ordinary review asks "is this code correct?" This asks **"who breaks it, and how?"** Your job is to
falsify specific security claims. A run that ends with "the design looks sound" and no attempted
attacks is a failed run.

Assume the design is wrong somewhere and go find where. Be adversarial, concrete, specific.

## Read first

1. `docs/architecture/e2ee-threat-model.md` — **the authority.** Adversaries `A1`–`A10`, claims
   `C1`–`C14`, the v1 regression table, and the known-and-accepted list. Cite its ids in every
   finding.
2. `docs/architecture/e2e-encryption.md` — as-built description. Treat every sentence as a **claim
   to test**, not as ground truth.
3. `~/dev/thunderbolt-spec/specs/e2ee-v2.md` — the crypto spec (intended design), if present.
4. The source. **Where the docs and the code disagree, the code wins and the disagreement is itself
   a finding.**

Do not re-derive the adversary list or the claims — they are versioned in the threat model so that
findings, attack specs, and Linear issues all cite the same ids.

## Argument

The scope to attack. One of the pass names below, or a free-form area.

## Passes

Run **one pass per invocation** — scoping is what stops parallel effort collapsing onto the same
shallow finding, and a fresh context is what stops the previous pass's framing anchoring this one.

| Pass | Scope |
| --- | --- |
| `crypto` | `src/crypto/*`, `shared/e2ee-types.ts` — AK/DEK generation, hybrid envelopes, HKDF/AES-KW, PBKDF2 params, BIP-39, AAD encoding (canonicalization, delimiter injection), canary, deterministic signing-key derivation |
| `codec` | `src/db/encryption/*` — dual-read dispatch, encode fail-closed, `isV2EncryptedValue`, keyring cache, `encryptedColumnsMap` coverage, upload encoder |
| `backend` | `backend/src/api/encryption.ts`, `account.ts`, `dal/encryption.ts`, `lib/canary.ts`, schema + migrations — authz, IDOR, nonce lifecycle, advisory locks, CAS, device-state transitions |
| `migration` | `src/services/encryption.ts` migrator/follower, `POST /upgrade`, `e2e/e2ee/migration.spec.ts` — interleavings, crash points, hostile flip, 409 path, continuity check, data loss |
| `lifecycle` | approve / deny / revoke / rotate / recover / change-phrase across services, hooks, backend. Focus `C5`, `C6`, `C9` |
| `escrow` | `backend/src/lib/org-escrow.ts`, `scripts/org-escrow-*.ts`, `wrapAKForOrg`, config + rollout. Focus `C11`, `C2` |
| `sync` | `src/db/powersync/*`, key-request responder, SharedWorker vs main thread, IndexedDB at rest, sign-out teardown, log/telemetry leaks. Focus `C1`, `C10`, `C13`, adversary `A6` |
| `sweep` | Take `A2` (malicious server) alone and walk **every** response the client trusts, end to end. Exists to catch what the file-scoped passes miss |

Stay in scope for depth, but report anything critical you stumble across outside it.

## Modes

### Reasoning pass (default)

Read-only. No stack, no execution. Produces candidate findings — **arguments, not confirmations**.

### Live hunt

Only when the user asks to attack a running system.

```bash
bash scripts/run-e2ee-powersync.sh    # Postgres + PowerSync on 5434/8081
```

Then drive real browsers with Playwright while holding direct Postgres access — you are playing the
**compelled server**, not an internet attacker. That position is the only way to test `C1` honestly.

Primitives live in `e2e/e2ee/db.ts` (a live `sql` client, seeds, `trustDevice`,
`getEncryptionServerSnapshot`) and `e2e/e2ee/helpers.ts` (`createIsolatedDevice`,
`revokeTrustedDevice`, `signOutKeepingData`, `getEncryptionKeyNames`). Verdict functions live in
`e2e/e2ee/oracles.ts` — call them rather than eyeballing output; they are the whole reason a live
run can check itself.

Throwaway attempts go in `e2e/e2ee/attacks/scratch/` (gitignored). **Every confirmed break becomes a
permanent spec** at `e2e/e2ee/attacks/<name>.spec.ts`, named for the claim it defends, and from then
on it gates every PR.

#### Rails — non-negotiable

- Local stack only. Never production, never a shared environment, never real user data.
- Test escrow keys only, from `scripts/org-escrow-keygen.ts`. Never an operator's real private key.
- Tear the stack down when finished.

## Rules of engagement

1. **Exploit-first.** A finding is a sequence of concrete steps by a named adversary reaching a
   stated impact. "This could be risky" is not a finding; "there is no rate limit" is not a finding
   unless you show what it unlocks.
2. **Cite `file.ts:line` for every claim about the code.** If you did not open the file, say so.
3. **Never invent code.** Needing to see something you cannot reach puts it under "Could not
   verify" — assumed code is the number-one source of bogus crypto findings.
4. **Try to refute yourself before reporting.** Spend genuine effort finding the guard that kills
   each candidate — a check in a caller, a DB constraint, a type, a middleware. If you find it, drop
   or downgrade the finding and say what saved it.
5. **Severity from preconditions, not category:**
   - **Critical** — a server-position or passive adversary (`A1`/`A2`/`A9`) recovers plaintext or the
     AK; or plaintext reaches the server.
   - **High** — an active or previously-trusted adversary (`A2`/`A4`/`A5`/`A6`/`A8`) recovers
     plaintext or key material; or permanent unrecoverable data loss.
   - **Medium** — downgrade, integrity/substitution/rollback without confidentiality loss; permanent
     lockout; a broken claim with no direct data impact.
   - **Low** — hardening, unexploitable-today weakness.
   - **Info** — doc/code divergence, unclear invariant, missing test.
6. **Proof of concept where feasible** — prefer a failing test in the repo's own harness
   (`bun test <path> --timeout 5000`, or `e2e/e2ee/`).
7. **No padding.** Ten real findings beat forty. "No findings in scope" plus what you checked is a
   useful result.
8. **Report design-level breaks, not just bugs.** A correct implementation of a broken protocol is
   the most expensive thing to discover late.

## Output

A one-paragraph verdict, then:

| # | Severity | Claim broken | Adversary | Title | Confidence |
| --- | --- | --- | --- | --- | --- |

Then one block per finding:

```
### F<n> — <title>
Severity: <…>   Confidence: <High|Medium|Low>
Breaks: <C-id(s) and/or THU-id(s)>   Adversary: <A-id>
Location: <file:line>, <file:line>

Preconditions   <exactly what the attacker must already have>
Attack          <concrete, ordered, reproducible steps>
Impact          <what they end up holding or destroying, in user terms>
Evidence        <quoted code + why the guard you looked for is absent or bypassable>
Refutation      <what you checked that could have killed this, and why it doesn't>
Fix direction   <architectural, not cosmetic>
PoC             <failing test / script, or "not attempted: <reason>">
```

End with:

- **Could not verify** — what you could not resolve from source, and what would settle it.
- **Claims that held** — for each claim you attacked and failed to break, one line on what stopped
  you. As valuable as the findings: it is the evidence the claim was actually tested.
- **Residual risk** — what this pass structurally could not cover.

## Seed hypotheses

**Unverified leads.** Several may be already-fixed or plain wrong. Do not anchor on them, never
report one without verifying it in the code, and do not let them cap your scope — the best finding
is probably not on this list.

1. A revoked device retains DEK `"0"` → the canary secret → the deterministic ECDSA signing key, and
   may still pass challenge-response after revocation. (`C5`/`C6`)
2. The org-escrow public key is fetched from the server the design distrusts; a malicious server
   substitutes its own and every client wraps the AK to it. (`C2`/`C11`)
3. Enabling `ORG_ESCROW_ENABLED` plus a forced rotation silently escrows accounts that never
   consented. (`C11`)
4. AAD has no version or sequence component → a malicious server rolls a cell back to an older valid
   ciphertext undetectably. (`C3`)
5. Anything that gets a v2-era value decoded through the AAD-free `"v1"` slot, or a v1-format value
   accepted on a fresh row, sidesteps THU-426. (`C4`)
6. `canary_secret_hash` is stored server-side and gates `/upgrade` — who can read it, is the proof
   replayable, is the hash a cheap offline target? (`C8`)
7. Recovery-slot re-anchoring needs only the public half, so any trusted device — or anyone who can
   write metadata — can repoint it. Silent lockout, or worse? (`C9`)
8. `GET /encryption/keys` was once observed serving keyring rows to denied-but-not-revoked devices,
   justified as "AES-KW-useless without the AK". Re-derive whether that still holds. (`C14`)
9. Unknown-`key_id` handling in the sync worker: confirm every branch defers or throws and none
   writes through in plaintext. (`C1`/`C13`)
10. `MIN_APP_VERSION` residual window from long-lived PowerSync tokens. (`C12`)
11. Concurrent `POST /encryption/keys` vs `/rotate` without an advisory lock strands a DEK under an
    old AK. (`C14`)

## Related

`/thunder-vuln-scan` and `/thunder-triage` (vendored, see `.claude/skills/UPSTREAM.md`) cover generic static
scanning; this skill covers the protocol-level attacks they structurally cannot find. Tuning files
for them live in `.claude/security/`.
