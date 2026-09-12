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
  or telemetry. The set of columns this covers is `encryptedColumnsMap`, and membership is the whole
  claim: a synced table with user-authored text and no map entry is not protected at all, which is
  how THU-870 shipped — `agents` was synced from `backend/drizzle/0018_colorful_lorna_dane.sql`
  onward while absent from the map, so every custom agent's `name`/`url`/`description` sat in
  Postgres in cleartext with no adversary action. Closed by adding `agents:
  ['name','url','description']`; `agents` was already synced, so no sync-rule change was needed. Two
  residuals. (1) **The fix is forward-only.** Rows written before the map entry existed stay
  cleartext at rest, because no re-encryption pass exists anywhere in the system — the same
  concession the permanently-AAD-free `"v1"` slot makes, and accepted on the same terms. So C1 holds
  for everything written after the entry, not for the back catalogue. (2) **Membership is unenforced
  by anything but a test.** `attacks/synced-table-coverage.spec.ts` is now the standing drift guard
  (green, untagged) and fails when a synced table with user-authored text has no map entry;
  `scanServerForPlaintext` cannot catch it, because it only scans MAPPED columns and so never looks
  at an unmapped table — which is precisely why the drift went unnoticed. Note also what membership
  does NOT buy: it stops the client uploading plaintext, and it is what lets THU-874's download-side
  check cover a column at all, but until 874 lands a server can still inject plaintext into a mapped
  column and have the client persist it verbatim. For `agents.url` — the routing field for both
  transports, iroh included — that is endpoint substitution, so C1 and the integrity half of this
  claim close together rather than separately.
- **C2 — Server cannot induce key disclosure.** No server-controlled input (metadata, keyring rows,
  `kdf_salt`, `key_version`, `scheme_version`, challenge nonces) steers a client into wrapping,
  sending, or deriving a key the server can open. The org-escrow public key left this list in
  THU-866: it is no longer a server-supplied input at all, because the wrap target comes from the
  build's own pin (see C11).

  The **AK envelope** was the sharpest violation, and it was FALSE until THU-869. `wrapAK` needs
  only a device's PUBLIC ECDH + ML-KEM keys, which the server stores, so the envelope is
  **anonymous**: A2 mints an Account Key of its own, wraps it to the victim's own public keys, and
  the device unwraps it with its own private keys with no way to tell the sender changed. Every
  write after that is sealed under a server-held key — and, because those writes are under a DEK
  absent from the honest keyring, they are lost to the user once the attack stops. A2 triggered the
  adoption at will: bump `key_version`, serve one unopenable ciphertext, or return any 4xx from
  `POST /encryption/rotate`. Reachable against an established, fully trusted device.

  The guard that existed was not one. `keyringUnwrapsUnderLocalAK` is a **currency** probe — it
  cannot authenticate anything, because on the `refreshAK` path the stored AK had already been
  replaced before it ran, and on the staging path *failing* it is what triggers the adoption. Its
  outcome was attacker-chosen either way.

  Now enforced by a **device-local witness to DEK `"0"`'s key material** (`keyring-anchor.ts`): a
  fixed-plaintext AES-GCM sample under DEK `"0"`, minted once from purely local state and never
  rewritten. A candidate AK is adopted only if it unwraps the **served** DEK `"0"` row into material
  that opens that sample. This rests on DEK `"0"`'s material being immutable for the life of a v2
  account — minted once at bootstrap or upgrade, re-wrapped (never re-minted) by every rotation —
  which is exactly why the witness is a ciphertext UNDER the key rather than a copy of its
  wrapping: a wrapping legitimately changes on every rotation, so it could never be written once,
  and a server can relabel one blob as another `key_id` (AES-KW carries no id binding) to repoint a
  witness that tracked wrappings. On refusal nothing is persisted: the device keeps the keys it
  had, keeps working, and recovers by itself when an openable envelope is served. The same change
  closed a follower TOCTOU — `followToV2` verified one keyring and persisted a re-fetched one, via a
  call that could itself adopt a fresh AK and un-set the AK just verified.

  **Residuals.** (1) A device's FIRST adoption is trust-on-first-use and cannot be otherwise: a new
  device shares no secret with the account and its only channel is the adversary. At approval there
  is nothing to check against; at phrase recovery the AK is wrapped *to* the recovery slot's public
  halves, which the server stores, so it can wrap its own AK to them. Authenticating that wrap
  under the phrase seed would close it and would break silent re-escrow on rotation — which is why
  THU-865 built an attestation instead, and that attestation is signed with a key this very attack
  controls. The real close is out-of-band device verification, a POC non-goal (see C11's first
  residual, which is the same wall). (2) **Rollback passes the witness by construction** — an old
  honest envelope with its matching old keyring verifies, because DEK `"0"` is immutable. The
  replayed set includes the canary, `signing_public_key` and `key_version`, so the device is
  returned wholesale to an epoch a revoked device holds and whose old envelope is valid for: that
  is **C5 defeated**, not C4's pointer residual, and no DEK-`"0"`-bound artifact can ever catch it.
  Closing it needs the keyring authenticated, and binding `key_id → material` rather than merely
  signing `key_version` (THU-890). (3) A refusing device keeps writing under its stale primary,
  which after a revocation-driven rotation is a DEK the revoked device holds — confidential against
  A2, **not** against A4. Failing `encode` closed instead would wall a legitimate user on a signal
  they cannot see. (4) **Ending an attack is what wedges the device**: pre-fix a device self-healed
  once A2 stopped lying, whereas a device whose witness was minted inside the attack window can
  never clear the check. Signing out clears it, at the cost of a re-approval; the phrase-recovery
  path stays ungated for exactly this reason. (5) A2 **withholding** an openable envelope is a DoS —
  degradation, not disclosure, same shape as C9's first residual. (6) The immutability this rests on
  is enforced at **no layer**: `assertRotateKeyCoverage` validates key_id sets, not key material,
  because the server holds no AK. A keyring compaction that drops `"0"`, a v3 that re-mints it, or a
  re-key must each delete the witness in the same change or every established device on the account
  refuses every future AK. Gated by `attacks/inbound-envelope-adoption.spec.ts` (green, untagged);
  the no-wedge property is gated by `rotation.spec.ts`'s surviving-third-device case.
- **C3 — Ciphertext integrity and placement.** AAD (`table ‖ column ‖ row_id ‖ key_id`) prevents a
  malicious server from moving, swapping, or replaying ciphertext into a different cell. Covers
  cross-cell, cross-table, cross-row, and same-cell rollback to an older ciphertext (note: the AAD
  carries no version or timestamp). **Cross-account is NOT covered by the AAD** — this claim listed
  it until 2026-09-12, and that was an overclaim. `encodeAAD` (`shared/e2ee-types.ts:204`) has no
  account component, the reconciled defaults ship hardcoded row ids (`tasks`, `skills`, `models`,
  `prompts` and `model_profiles` are each fixed-id *and* in `encryptedColumnsMap`), and every synced
  table is keyed `(id, user_id)` so the same id exists once per account — so on those rows the AAD
  is byte-identical across accounts. Cross-account separation is therefore **cryptographic**
  (per-account DEK material), not contextual: relocation discloses only where the destination
  resolves the *same* key material, and across accounts it never does — `decrypt` fails on the auth
  tag before the AAD is ever consulted. The precondition this now rests on is that **no DEK material
  is ever shared between two accounts**, and it holds structurally rather than by convention. (1)
  Shared/workspace DEKs are foreclosed by the mint grammar (`keyIdPattern`,
  `shared/e2ee-types.ts:61`; the server rejects anything outside it — see C15), so reintroducing one
  is a wire-format change rather than a comment someone implements. (2) A2 never holds another
  account's AK in openable form: only wrappings to that account's own device public keys, plus the
  org-escrow envelope, which is C8's deliberate operator concession. (3) A `user_id` never changes
  under a live account — `onLinkAccount` (`backend/src/auth/auth.ts:414`) deletes the anonymous user
  outright, so no ciphertext survives an id change. Any change to (1) or (2) invalidates this claim
  and must revisit the AAD. **Adding the account id to the AAD was considered and rejected**
  (THU-891, cancelled): it closes nothing reachable, and against the one path that *is* reachable —
  the residual below — it is either inert or harmful. `codec.decode` runs in the SharedWorker, which
  has no localStorage, so the id would have to come from state staged *with the keys*, and in that
  scenario the staged id is the stale account's and matches the relocated ciphertext anyway;
  sourcing it from the session instead auth-tag-fails every row at once whenever the session cache
  is cleared (401) while the keys are deliberately kept, and `codec.decode` fails **open** to the
  raw `__enc:v2:…` string (`src/db/encryption/codec.ts:388`), so the app would fill with unreadable
  values and raise nothing. Residual: a **failed local wipe** leaves the one reachable cross-account
  read. `handleFullWipe` throwing is logged-and-continued by `clearLocalData`
  (`src/lib/cleanup.ts:55`), so a device signed in as B can still hold A's AK and A's staged DEKs.
  C2's witness correctly refuses the inbound AK (`material-mismatch`), but a refusal leaves local
  key state as A's, so rows A2 pushes into B's sync stream under their original ids decrypt and
  render. Narrow — it needs an IndexedDB wipe failure, a second account in the same browser, and a
  hostile server — and the refusal makes the common case a loud wedge rather than silent confusion.
  The fix is account-scoped key storage or a fail-closed wipe, not the AAD.
- **C4 — No v1 downgrade.** A v2 client never writes v1 (no-AAD) format and cannot be steered back
  into doing so — not by a server reporting `scheme_version: 1`, not by a `key_id` of `"v1"` on a
  write path. The `"v1"` slot is never usable as an AAD-free oracle over v2 data. The second clause
  was FALSE until THU-876: `primary_key_id` is server-supplied and was stored verbatim, so one
  rewritten metadata field sealed every new write on a migrated account under the decrypt-only
  legacy CK — well-formed, AAD-bound `__enc:v2:v1:…`, so **key reuse rather than a format
  downgrade**, but outside the hierarchy revocation controls (chained with THU-877, where A2 also
  chooses that key, it breaks **C1** outright). It is now enforced by the mint grammar
  (`isMintableKeyId`, which excludes `legacyKeyId` by construction — see C15) at three points: the
  pointer is refused where a server response enters (`applyKeyring` keeps the primary already in
  force; the upload path defers the batch), refused where it would become durable
  (`storePrimaryKeyId`), and refused at the point of use (`codec.encode` fails closed). The last is
  what makes a *transient* in-origin compromise (A6) non-persistent: the pointer lives in IndexedDB,
  so one write around the API would otherwise steer every future write for the life of the device.

  Residual: the pointer is unauthenticated server data, so a **grammar-valid** rollback is still
  open — A2 reporting `"0"` on an account that rotated to `"1"` puts new writes back under a DEK a
  revoked device copied while trusted. Same shape as C5's guarantee, different label. Nothing the
  client holds can settle it: the canary, the one artifact a server cannot forge, is deliberately
  bound to DEK `"0"` for the life of the account, so it attests nothing about which DEK is primary.
  Closing it means signing the keyring (`primary_key_id` + `key_version`) under the epoch signing
  key, or a monotonic local guard — which protects only a device that already saw the newer
  pointer, since a freshly enrolled one has no baseline.
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
  (THU-877). Same scope for the follower-side continuity check. This concession is also why the
  canary cannot serve as C2's anchor for an inbound Account Key: verifying a server-served canary
  under a server-served DEK, reached through a server-served AK, is the same tautology one level up.
  Hence the separate device-local witness there.
- **C9 — Recovery-phrase path is sound.** 256-bit CSPRNG entropy; PBKDF2-SHA512 600k with a
  per-account salt; the derived public half is checked against the stored one before use; a wrong
  server-supplied `kdf_salt` or public key fails cleanly rather than downgrading or leaking. Recovery-
  slot re-anchoring (which needs only the public half) cannot be abused for takeover: the anchor
  carries a **recovery attestation** (THU-865) signed with the epoch's canary-derived signing key, and
  a rotating device verifies it against a key it derives from its OWN keyring before wrapping. A2
  cannot forge that signature — it does not hold DEK `"0"`, so it cannot learn the canary secret — and
  a missing or bad attestation fails closed, so a substituted anchor aborts the rotation instead of
  escrowing the next AK. Gated by `attacks/recovery-slot-substitution.spec.ts` (green, untagged).
  **Four residuals.** (1) A2 can *withhold* the attestation and thereby block AK rotation —
  degradation, not takeover, same shape as THU-871. (2) The signing key derives from the canary
  secret, and a **revoked** device retains DEK `"0"` and can still fetch the current canary (THU-872),
  so A2 colluding with a revoked device can forge an attestation; closing THU-872 closes this too.
  (3) `revokeDeviceAndRotate` verifies the anchor only at its third step, so under this attack the
  revoke and DEK rotation commit while the AK never rotates — pre-flighting the check is follow-up.
  (4) **The verifying key is only as trustworthy as the AK it derives through.** "A key it derives
  from its OWN keyring" means AK → DEK `"0"` → canary → signing key, and until THU-869 the AK itself
  was adoptable from a server-minted envelope — so A2 substituted the AK and thereby owned the key
  that verifies the attestation, with no collusion needed. Closed for an **established** device,
  which now refuses an AK that cannot reproduce its DEK `"0"` witness (see C2). NOT closed for a
  freshly enrolled one, whose first adoption is trust-on-first-use: there, this claim still rests on
  the server not having substituted the AK at enrolment.
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

  The grammar is also the **admissibility** rule for the primary pointer, not only the allocation
  rule: `legacyKeyId` sits outside it precisely so that "which id may be minted" and "which id may
  encrypt new writes" are the same question (THU-876, see C4).

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
