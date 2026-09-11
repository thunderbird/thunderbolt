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
| A8 | Malicious operator | Holds the org-escrow private key. Since THU-866 substituting the *public* key needs control of the client **release** — the wrap target is the build's own pin — not just `ORG_ESCROW_ENABLED` and the server env. |
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
  `kdf_salt`, `key_version`, `scheme_version`, challenge nonces) steers a client into wrapping,
  sending, or deriving a key the server can open. The org-escrow public key left this list in
  THU-866: it is no longer a server-supplied input at all, because the wrap target comes from the
  build's own pin (see C11).
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
  lives under a DEK the revoked device may still hold. That retained key is why the third clause now
  rests on device—session binding rather than on the proof (THU-873): a proof shows *account* key
  possession, so only `session.deviceId` establishes *which* device is calling. A revoked device can
  rebind only as itself, and that row is revoked. Revocation also has to SURVIVE a hostile keyring:
  one unopenable `wrapped_keys` row used to throw the whole AK rotation, so a single planted row
  voided the cryptographic half of every future revocation, permanently (THU-871 — see C15).
- **C6 — Challenge-response is not replayable or confusable.** Nonces are single-use, expiring, and
  bound to user, device, and operation (approve / deny / revoke / rotate / recover / node-id). No
  cross-operation confusion, no cross-device reuse, no TOCTOU between issue and consume, no endpoint
  missing the gate. The bound device is **server-resolved** from `session.deviceId`, not asserted by
  the caller's `X-Device-ID` header (THU-873); the `bind` nonce that establishes that binding is
  disjoint from the signable operations and is only ever returned sealed to the device's public key,
  so it can be neither minted in cleartext nor replayed as a proof.
- **C7 — Migration is atomic and lossless.** Exactly one migrator wins the CAS; a 409 loser degrades
  cleanly; nothing is persisted locally before HTTP 200; the recovery phrase is shown only on 200. A
  hostile flip from a stolen session is a recoverable DoS — never plaintext exposure or data loss.
- **C8 — Possession proof is meaningful against A4/A5.** `hash(canarySecret) == canary_secret_hash`
  proves CK possession to an adversary that cannot rewrite the DB — a stolen session (A5) or a
  key-holding device (A4) — and A5 (no keys) cannot satisfy it. It does **not** bind against A2/A9,
  who author `canary_secret_hash` and can forge a self-consistent `(secret, hash, canary)` triple; the
  migrator absorbs the CK from that forged canary without checking it against real legacy data
  (THU-877). Same scope for the follower-side continuity check.
- **C9 — Recovery-phrase path is sound.** 256-bit CSPRNG entropy; PBKDF2-SHA512 600k with a
  per-account salt; the derived public half is checked against the stored one before use; a wrong
  server-supplied `kdf_salt` or public key fails cleanly rather than downgrading or leaking. Recovery-
  slot re-anchoring (which needs only the public half) cannot be abused for takeover: the anchor
  carries a **recovery attestation** (THU-865) signed with the epoch's canary-derived signing key, and
  a rotating device verifies it against a key it derives from its OWN keyring before wrapping. A2
  cannot forge that signature — it does not hold DEK `"0"`, so it cannot learn the canary secret — and
  a missing or bad attestation fails closed, so a substituted anchor aborts the rotation instead of
  escrowing the next AK. Gated by `attacks/recovery-slot-substitution.spec.ts` (green, untagged).
  **Three residuals.** (1) A2 can *withhold* the attestation and thereby block AK rotation —
  degradation, not takeover, same shape as THU-871. (2) The signing key derives from the canary
  secret, and a **revoked** device retains DEK `"0"` and can still fetch the current canary (THU-872),
  so A2 colluding with a revoked device can forge an attestation; closing THU-872 closes this too.
  (3) `revokeDeviceAndRotate` verifies the anchor only at its third step, so under this attack the
  revoke and DEK rotation commit while the AK never rotates — pre-flighting the check is follow-up.
- **C10 — Key material at rest.** Non-extractable where it must be; the ML-KEM secret is encrypted at
  rest and its wrapping key is itself non-extractable; `rewrapKeyring`'s temporary extractability is
  never persisted; sign-out leaves no orphaned key.
- **C11 — Escrow does not break C1.** The server holds only the public half, and pinning is what
  carries the weight the claim always needed: the client wraps the AK to the key **its own build
  pins** (`VITE_ORG_ESCROW_PUBLIC_KEY`) — and there is no longer any endpoint serving one, nor an
  escrow key in the server's own config (THU-866).
  No pin means no envelope, so a server that claims escrow is on for a deployment which configured
  none captures nothing; a pin means that key alone, so escrow can be neither redirected nor
  suppressed. That is also what settles "enabling escrow must not silently capture accounts that
  never consented" — escrow now takes a deliberate build artifact, not a server flag. TOFU was never
  an option here: the first fetch *is* the escrow event, so it would pin the attacker's key. Gated by
  `attacks/org-key-substitution.spec.ts`. The documented post-quantum forfeiture is the only PQ
  regression.
  **Two residuals.** (1) A build-time pin is a full trust root only where the bundle ships out of
  band — the Tauri desktop/mobile builds. For the **web** build A2 also serves the JS, so it can
  serve a bundle carrying a different pin; what the pin buys there is a change of kind, turning an
  invisible per-request JSON lie into a persistent, cacheable, diffable bundle modification. Closing
  that needs out-of-band fingerprint verification by the user, which the POC lists as a non-goal.
  (2) A build pinning the wrong key escrows to something the operator cannot open, and nothing
  detects it — the server holds no key to compare against, by design. Catching that would need the
  client to declare its wrap target and the server to hold a key again, trading a silent
  misconfiguration for a restored steering surface; the POC accepts the former.
- **C12 — Rollout gate holds.** `MIN_APP_VERSION` prevents a below-min client from syncing a flipped
  account, including via exempt routes, long-TTL PowerSync tokens, and `X-App-Version` spoofing.
- **C13 — Multi-tab / worker key plumbing.** The key-request `BroadcastChannel` and SharedWorker path
  cannot be driven by A6 to exfiltrate keys, stage attacker-supplied keyring material, or fail open
  on an unknown `key_id`.
- **C14 — Authorization on every endpoint.** Every encryption and device route scopes by
  authenticated user and device state (pending / trusted / denied / revoked). No IDOR, no keyring
  material served to untrusted devices, no missing advisory lock that strands a key under an old AK.
  Since THU-873 the *caller* device is also authenticated rather than asserted: a session acts only
  as the device it proved possession of via the sealed-nonce bind handshake. The sync routes
  (`GET /powersync/token`, `PUT /powersync/upload`) are pinned to the same binding, so a revoked
  device with a surviving unlinked session cannot name a trusted sibling to keep reading or writing
  the stream. Accepted constraint: a client that holds no device keypair (an API-key job, a future
  headless integration) cannot bind and therefore cannot sync — it must enrol as a device.
- **C15 — Keyring integrity and DEK-minting soundness.** A `wrapped_keys` row the account cannot
  open — planted in the DB by A2, or minted by A6 from a trusted device — cannot brick the account.
  Minting a DEK always yields a key the account actually holds: `key_id`s come from a bounded
  canonical grammar (`keyIdPattern`, unpadded decimal ≤ 15 digits) and the allocator claims the
  smallest UNUSED counter, so a planted row can neither alias the id being minted nor push the
  allocation outside the grammar the server enforces; a mint that conflicts aborts its transaction
  instead of being silently discarded; and a mint happens ONLY inside an AK rotation — so it is
  atomic with the
  rotation, is always wrapped under the AK that request installs, and there is no standalone endpoint
  for planting rows. An unopenable row cannot void a rotation either: it is passed through with its
  original wrapping and logged, never dropped (which would strand its data) and never deleted (which
  would turn recoverable corruption into permanent loss on a claim the server cannot verify — the
  slot is what lets a device still holding the relevant AK repair it later).

  Residuals: passed-through rows accumulate, so an operator-gated cleanup is still owed; a keyring
  grown past `maxKeyringKeys` rows cannot be re-wrapped in one atomic request, which A2 can still
  reach through direct DB writes; and a revocation whose rotation fails leaves the device revoked but
  not cryptographically locked out, with no in-UI affordance to resume it
  (`src/settings/devices.tsx` hides the button once `revokedAt` is set).

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
  revocation on disable, no recovery audit trail, no in-app admin decrypt, and no detection of a
  build pinned to the wrong escrow key (THU-866 residual — see C11).
- **Decrypt-failure handling and keys-before-data ordering** are deferred (planning gaps G2/G3);
  PowerSync retries make naive fail-closed poison the sync loop.
- **Device fingerprint verification at approval** (Signal-style code compare) is deferred (G5).

## Consumers

| Surface | How it uses this document |
| --- | --- |
| Red-team passes | the `thunder-red-team` skill cites the A-ids and C-ids |
| `thunder-deep-review` | security dimension loads this file for crypto-path diffs |
| `e2e/e2ee/attacks/*` | each spec names the claim it defends |
