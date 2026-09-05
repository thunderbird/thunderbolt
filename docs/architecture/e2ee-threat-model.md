# E2EE Threat Model

The adversaries our end-to-end encryption is meant to withstand, the security claims it makes, and
the v1 weaknesses v2 exists to close. Written for **security review** — for how the system works, see
[e2e-encryption.md](e2e-encryption.md).

This is the single source of truth for every security-review surface: the red-team passes, the
security dimension in `thunder-deep-review`, and the attack specs in `e2e/e2ee/`. Keep the C-ids and
A-ids stable — findings, tests, and Linear issues cite them.

## Adversaries

| # | Adversary | Capabilities |
| --- | --- | --- |
| A1 | Honest-but-curious server | Reads every table, request, response, ciphertext, envelope, and metadata row. Passive only. |
| A2 | Malicious / compelled / breached server | A1, plus arbitrary responses: lies about metadata (`scheme_version`, `kdf_salt`, `key_version`, org-escrow public key), reorders, replays, withholds, forges or drops envelopes, restores an older DB snapshot. **The adversary the headline claim is about.** |
| A3 | Network attacker | MITM under TLS-stripping / compromised-CA assumptions; replay and reorder. |
| A4 | Revoked device | Held full trust once; still holds whatever it cached locally. Assume worst case: a still-valid stolen session. |
| A5 | Stolen live session | Valid auth token, no AK, no DEK, no device private keys. Can call every endpoint. |
| A6 | Same-origin script | XSS or hostile extension running in the app origin. Reaches IndexedDB, `BroadcastChannel`, the SharedWorker, and the API. |
| A7 | Another tenant | Own valid account. Tries to touch another user's rows, envelopes, nonces, keyring, or escrow row. |
| A8 | Malicious operator | Holds the org-escrow private key, or can enable `ORG_ESCROW_ENABLED` and substitute the public key. |
| A9 | Harvest-now-decrypt-later | Records everything today, gets a cryptographically-relevant quantum computer later. |
| A10 | Stale / offline / downgraded client | Old app version, or offline across a migration, rotation, or revocation — including a client an attacker *forces* into that state. |

## Claims

Each is asserted by the design or by [e2e-encryption.md](e2e-encryption.md). Each is a hypothesis to
falsify, not a fact.

- **C1 — Zero-knowledge server.** The server never obtains plaintext or any key that yields it, even
  when malicious or compelled. No client path uploads plaintext into an encrypted column; no
  fail-open in the codec, upload encoder, or sync middleware; no plaintext in logs, error payloads,
  or telemetry.
- **C2 — Server cannot induce key disclosure.** No server-controlled input (metadata, keyring rows,
  org-escrow public key, `kdf_salt`, `key_version`, `scheme_version`, challenge nonces) steers a
  client into wrapping, sending, or deriving a key the server can open.
- **C3 — Ciphertext integrity and placement.** AAD (`table ‖ column ‖ row_id ‖ key_id`) prevents a
  malicious server from moving, swapping, or replaying ciphertext into a different cell. Covers
  cross-cell, cross-table, cross-row, cross-account, and same-cell rollback to an older ciphertext
  (note: the AAD carries no version or timestamp).
- **C4 — No v1 downgrade.** A v2 client never writes v1 (no-AAD) format and cannot be steered back
  into doing so — not by a server reporting `scheme_version: 1`, not by a `key_id` of `"v1"` on a
  write path. The `"v1"` slot is never usable as an AAD-free oracle over v2 data.
- **C5 — Revocation is cryptographic.** After `revokeDeviceAndRotate`, the removed device cannot
  read new data, cannot obtain the new AK or primary DEK, **and cannot authorize any further trust
  operation.** Note the coupling: the ECDSA signing keypair is derived from the canary secret, which
  lives under a DEK the revoked device may still hold.
- **C6 — Challenge-response is not replayable or confusable.** Nonces are single-use, expiring, and
  bound to user, device, and operation (approve / deny / revoke / rotate / recover / node-id). No
  cross-operation confusion, no cross-device reuse, no TOCTOU between issue and consume, no endpoint
  missing the gate.
- **C7 — Migration is atomic and lossless.** Exactly one migrator wins the CAS; a 409 loser degrades
  cleanly; nothing is persisted locally before HTTP 200; the recovery phrase is shown only on 200. A
  hostile flip from a stolen session is a recoverable DoS — never plaintext exposure or data loss.
- **C8 — Possession proof is meaningful.** `hash(canarySecret) == canary_secret_hash` proves CK
  possession and cannot be satisfied by A2 or A5. Same bar for the follower-side continuity check.
- **C9 — Recovery-phrase path is sound.** 256-bit CSPRNG entropy; PBKDF2-SHA512 600k with a
  per-account salt; the derived public half is checked against the stored one before use; a wrong
  server-supplied `kdf_salt` or public key fails cleanly rather than downgrading or leaking. Recovery-
  slot re-anchoring (which needs only the public half) cannot be abused for takeover.
- **C10 — Key material at rest.** Non-extractable where it must be; the ML-KEM secret is encrypted at
  rest and its wrapping key is itself non-extractable; `rewrapKeyring`'s temporary extractability is
  never persisted; sign-out leaves no orphaned key.
- **C11 — Escrow does not break C1.** The server holds only the public half. But the client fetches
  that public key *from the server it is defending against* — pinning, TOFU, or out-of-band
  verification must carry that weight. Enabling escrow must not silently capture accounts that never
  consented. The documented post-quantum forfeiture is the only PQ regression.
- **C12 — Rollout gate holds.** `MIN_APP_VERSION` prevents a below-min client from syncing a flipped
  account, including via exempt routes, long-TTL PowerSync tokens, and `X-App-Version` spoofing.
- **C13 — Multi-tab / worker key plumbing.** The key-request `BroadcastChannel` and SharedWorker path
  cannot be driven by A6 to exfiltrate keys, stage attacker-supplied keyring material, or fail open
  on an unknown `key_id`.
- **C14 — Authorization on every endpoint.** Every encryption and device route scopes by
  authenticated user and device state (pending / trusted / denied / revoked). No IDOR, no keyring
  material served to untrusted devices, no missing advisory lock that strands a key under an old AK.

## v1 regressions

v2 exists to close these. For each: closed, partially closed, moved, or reintroduced?

| ID | v1 weakness | v2's claimed fix |
| --- | --- | --- |
| THU-429 | `codec.encode()` returned any `__enc:`-prefixed input unencrypted → plaintext to server | encode always encrypts; no prefix bypass; fails **closed** |
| THU-426 | AES-GCM with no AAD → ciphertext substitution | AAD = `table ‖ column ‖ row_id ‖ key_id` on v2 writes |
| THU-414 | Recovery mnemonic *was* the raw CK, no KDF | mnemonic → seed → PBKDF2-SHA512 600k + per-account salt |
| THU-427 | ML-KEM secret stored as extractable raw bytes | encrypted at rest (self-ECDH → HKDF) |
| THU-434 | No master-key rotation; static replayable canary proof | AK + DEK rotation (0 rows re-encrypted); ECDSA challenge-response |
| THU-430 | Revocation without CK-possession proof → E2EE state reset | signature-gated revoke + rotation |

**Partial fixes deserve the most attention.** THU-426 is fixed for v2 rows, but the `"v1"` slot is
deliberately AAD-free forever — quantify what that leaves exposed. THU-434's canary is now
load-bearing for *identity*, not just key verification — price that new coupling (see C5).

## Known and accepted

Not findings. Documented trade-offs, listed so review does not relitigate them.

- **Local SQLite is plaintext at rest.** Deferred by design (v2 planning gap G4). In scope to
  quantify under A6 and device theft; out of scope to fix here.
- **The `"v1"` DEK slot is AAD-free, permanently.** Legacy rows carry no AAD and are read in place
  forever; there is no bulk re-upload. Only *new* exposure through that slot is a finding.
- **Escrow is classical P-256, not hybrid.** An account with escrow enabled forfeits post-quantum
  protection for its AK — accepted POC trade-off, documented in `e2e-encryption.md`.
- **Escrow POC non-goals:** no end-user disclosure UI, no backfill for pre-escrow accounts, no
  revocation on disable, no recovery audit trail, no in-app admin decrypt.
- **Decrypt-failure handling and keys-before-data ordering** are deferred (planning gaps G2/G3);
  PowerSync retries make naive fail-closed poison the sync loop.
- **Device fingerprint verification at approval** (Signal-style code compare) is deferred (G5).

## Consumers

| Surface | How it uses this document |
| --- | --- |
| Red-team passes | the `thunder-red-team` skill cites the A-ids and C-ids |
| `thunder-deep-review` | security dimension loads this file for crypto-path diffs |
| `e2e/e2ee/attacks/*` | each spec names the claim it defends |
| `/thunder-vuln-scan --extra` | `.claude/security/scan-extras.txt` points here |
