# End-to-End Encryption

> ⚠️ End-to-end encryption is in **Preview**. It has not yet undergone a cryptography audit and is subject to further refinements.

Thunderbolt provides zero-knowledge end-to-end encryption: all user data is encrypted client-side before sync and decrypted client-side after download. The server stores only ciphertext and wrapped keys — it cannot read user data even if compelled or breached.

This document describes **E2EE v2** — the AK/DEK key hierarchy with hybrid post-quantum device envelopes, AAD-bound versioned ciphertext, ECDSA challenge-response device management, and the **data-preserving v1 → v2 migration** (absorb + permanent dual-read). For the sync pipeline integration, see [powersync-sync-middleware.md](powersync-sync-middleware.md).

---

## Configuration

E2EE is **always on** — there is no toggle and no disabled state. The `E2EE_ENABLED` flag was removed because a value served by `GET /v1/config` let a malicious or compelled server disable client-side encryption (the red team's `config-downgrade` finding). Whether an account is encrypted is derived **per account**, never from server config:

- **Client:** local key material is the authority. `needsSyncSetupWizard()` in `src/db/encryption/config.ts` returns `true` until an AK plus at least one wrapped DEK exist locally, and `codec.encode` fails closed whenever setup has completed or an AK is present. The connector's canary probe (`GET /encryption/canary`) distinguishes a genuinely pre-E2EE account (404 → plaintext passthrough by design) from an unprovable state (offline/5xx → uploads deferred, download credentials withheld).
- **Backend:** the presence of an `encryption_metadata` row (`schemeVersion === 2`) marks the account encrypted; the upload backstop rejects plaintext in mapped columns for such accounts. Devices are never auto-trusted — every device must be registered via `POST /devices` and complete the envelope/trust flow before `GET /powersync/token` or `PUT /powersync/upload` succeed.

**Compatibility shim:** `GET /v1/config` still returns a hard-coded `e2eeEnabled: true`. Pre-cutover bundles gate `encodeForUpload` on that key, and `updateConfig` replaces the whole config object — omitting it would make a stale client read `undefined`, skip encryption, and upload plaintext into an account current clients treat as encrypted (permanently, since there is no re-encryption pass). The shim is safe to delete only once `MIN_APP_VERSION` is at or above the first always-on release, which 426s every client that still reads it.

Rolling out always-on E2EE to a deployment where encryption was previously optional is itself a **hard cutover**: raise `MIN_APP_VERSION` past the first always-on release so stranded pre-cutover clients get a 426 instead of silently uploading plaintext. Rows written as plaintext before the cutover stay plaintext — dual-read passes them through indefinitely.

### Migration gate (`MIN_APP_VERSION`)

The v1 → v2 rollout is a **hard cutover** guarded by the app-version gate (`createAppVersionMiddleware`, mounted before auth in `backend/src/index.ts`). When `MIN_APP_VERSION` is set, every non-exempt `/v1` request from a below-minimum client (including `GET /v1/powersync/token`) is rejected with **426 Upgrade Required** — fail-closed, so a missing `X-App-Version` is also rejected. This prevents a live v1 client from syncing a flipped account with stale code. See [powersync-account-devices.md](powersync-account-devices.md) and the migration section below.

---

## Key Concepts

| Concept                  | Description                                                                                                                                                                     |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Device key pair**      | Each device generates an **ECDH P-256** key pair and an **ML-KEM-768** key pair. Private keys never leave the device. The ML-KEM secret is encrypted at rest (self-ECDH → HKDF). |
| **Account Key (AK)**     | An **AES-256** key with `wrapKey`/`unwrapKey` usages **only** — it never encrypts data; it is pure access control over the keyring. Randomly generated, never derived, so it can be rotated without the user's phrase. |
| **DEK keyring**          | Versioned **AES-256-GCM** Data Encryption Keys (`key_id` `"0"`, `"1"`, …). Exactly one is `primary` (encrypts new writes); older DEKs are retained forever for reads. A `key_id` is an unpadded decimal counter of at most 15 digits (`keyIdPattern`) — bounded so the "next id" arithmetic stays exact, see [Minting a DEK](#minting-a-dek). |
| **`"v1"` slot**          | A reserved, read-only DEK slot holding the **absorbed legacy CK** from a migrated account. Decrypts legacy `__enc:<iv>:<ct>` rows (no AAD) forever. Never encrypts. See migration. |
| **Device envelope**      | The **AK** wrapped for one device via a hybrid ECDH + ML-KEM envelope. (The stored column is still named `wrapped_ck` for wire compatibility — it carries the AK.)             |
| **Recovery key**         | The 256-bit recovery **seed** encoded as a **24-word BIP-39 mnemonic**. Shown once at setup/migration/phrase change. `mnemonic → seed → KDF → recovery keypair`.               |
| **Recovery slot**        | The recovery phrase as a **virtual device**: the seed-derived hybrid PUBLIC keys plus the AK wrapped to them, stored on `encryption_metadata`. Because wrapping needs only the public half, any trusted device can re-anchor the slot to a new AK — which is why revocation no longer invalidates the phrase. |
| **Recovery attestation** | A signature over `userId ‖ kdf_salt ‖ recovery public keys`, made with the epoch's canary-derived signing key and stored in `recovery_attestation` (THU-865). Written by every path that establishes a recovery slot; verified by any device about to re-anchor, against a signing key it derives from its own keyring. It is what stops a lying server from substituting recovery keys and capturing the next AK — see [Verifying the recovery anchor](#verifying-the-recovery-anchor). |
| **Canary**               | A known prefix + secret encrypted under the **primary DEK** with `canaryAAD(userId, keyId)`. Verifies key material at unlock and seeds the challenge-response signing keypair.  |
| **Challenge-response**   | An ECDSA P-256 keypair **deterministically derived from the canary secret**. Every post-flip trust op (approve/deny/revoke/rotate/recover) is signature-gated by a single-use server nonce. |

## Key Hierarchy

Two tiers: the AK gates the keyring; the primary DEK encrypts data. AK rotation and DEK rotation both re-encrypt **zero** data rows.

```
24-word BIP-39 recovery seed
        │  PBKDF2-SHA512, 600k iters, per-account kdf_salt
        ▼
recovery keypair (ECDH-P256 + ML-KEM-768) — public half stored server-side
        ▲  hybrid envelope, alongside one per device
        │
       AK (Account Key, AES-256, wrapKey/unwrapKey only — randomly generated)
        │  AES-KW wraps ▼
   DEK keyring (versioned, AES-256-GCM)
        ├─ key_id "0"   (primary — encrypts new writes)
        ├─ key_id "1"…  (older DEK versions — retained for reads)
        └─ key_id "v1"  (reserved, read-only: the absorbed legacy CK)
        │  AES-256-GCM + AAD encrypts ▼
      column data
```

Each device unwraps its own envelope to arrive at the same AK, then unwraps the wrapped-DEK keyring under that AK. The recovery slot is one more envelope over the same AK, so entering the phrase lands on exactly the same key hierarchy a device does.

### Minting a DEK

A new `key_id` enters an established keyring in exactly one way: the optional `newPrimaryKey` field on `POST /v1/encryption/rotate`. There is deliberately **no** standalone "add a key" endpoint (THU-871). Three properties follow from that, and all three were bugs before it:

- **Atomic with the rotation.** A revocation needs both rotations, and an AK rotation is the step that is *documented* to ask the caller to retry. When the mint was its own request, every retry minted another keyring row, so a user on a flaky connection ratcheted their keyring toward the size at which no rotation fits in one request at all. A failed rotation now adds nothing.
- **Always wrapped under the current AK.** The minted DEK is wrapped under the very AK that request installs, so it cannot be stranded under a stale one. Previously a device with an outdated AK could still pass the `rotate` proof — which attests possession of DEK `"0"`, not AK currency — and insert a row wrapped under the old AK, leaving the keyring mixed.
- **No cheap planting surface.** An in-origin script on a trusted device (A6) could otherwise mint arbitrary unopenable rows with a valid proof.

The `key_id` itself is allocated client-side as the **smallest canonical counter not already on the keyring**. On a healthy account that is just "one past the last" — rows are never deleted, so the ids run `0, 1, 2, …` with no holes — but choosing a hole rather than a maximum is what makes a planted row inert instead of load-bearing. Two earlier shapes of this allocation were both exploitable: an unfiltered `max + 1` collided with a row labelled with 17+ digits (`max + 1 === max` past 2^53), and a grammar-filtered `max + 1` still walked off the end of the grammar if a row claimed `999999999999999`, producing an id the server itself rejects and blocking every revocation. Smallest-unused cannot do either: the result is by construction absent from the keyring, and pigeonhole keeps it bounded by the keyring's own size.

The grammar (`keyIdPattern`: unpadded decimal, ≤ 15 digits) keeps ids short on the wire — every encrypted cell carries one — canonical, and tightly validatable. The server independently validates it on `newPrimaryKey`, rejects an id that already exists, and asserts the insert actually happened: a conflict aborts the whole rotation instead of being silently dropped.

The re-wrap path stays deliberately permissive about ids that *already* exist (`^[^:]+$`), because an account may carry a row that predates the grammar or was planted; rejecting it there would make that account permanently unrotatable.

### Which key is primary

`primary_key_id` arrives from the server (`GET /v1/encryption/canary`) and is the only piece of keyring state that is **not self-verifying**: every wrapped DEK has to unwrap under the device's AK, while the pointer has to be taken on trust. So the client validates it against the same mint grammar before it is allowed to matter (THU-876), at three points — `applyKeyring` skips a non-mintable pointer and keeps the one already in force (the upload path defers the batch instead), `storePrimaryKeyId` refuses to persist one, and `codec.encode` fails closed if it finds one anyway. The last of those is not redundant: the pointer lives in IndexedDB, so without it a single write from an in-origin script would steer every future write for the life of the device, long after the script itself was gone.

The reserved `"v1"` slot is the reason this matters. It sits outside the grammar deliberately (`isMintableKeyId(legacyKeyId) === false`) because it is **decrypt-only**: it never rotates, revocation never re-wraps it, and the v1 recovery mnemonic *was* that key, so anyone holding an old phrase or retired device can open anything written under it. A pointer at `"v1"` would therefore produce well-formed, AAD-bound ciphertext that is nonetheless outside the hierarchy revocation controls.

What the client cannot do is verify that a *grammar-valid* pointer is the newest one — the canary, the one artifact a server cannot forge, is deliberately bound to DEK `"0"` for the life of the account, so it attests nothing about which DEK is primary. Authenticating the pointer would mean signing the keyring.

## Wire Format

New (v2) encrypted column values are written with a version tag, the `key_id`, and AAD bound to the row context (never stored on the wire):

```
__enc:v2:<key_id>:<iv-base64>:<ciphertext-base64>      AAD = table ‖ column ‖ row_id ‖ key_id
```

Legacy (v1) values from before migration are read **in place, forever** and carry no version, no `key_id`, and no AAD:

```
__enc:<iv-base64>:<ciphertext-base64>                  decrypted via the "v1" DEK slot, NO AAD
```

`isV2EncryptedValue` in `src/db/encryption/wire-format.ts` is the single v1/v2 classifier. The codec **reads both** formats but **writes only v2** (dual-read, write-v2). `encode()` always encrypts (no `__enc:`-prefixed idempotency bypass); `decode()` dispatches on the wire version. The download/upload middleware read which columns to encrypt from `encryptedColumnsMap` in [src/db/encryption/config.ts](../../src/db/encryption/config.ts); decode stays prefix-gated so a stale client still decodes columns it doesn't know are encrypted.

## User Flows

| Scenario              | What happens                                                                                                                                                     |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **First device**      | Enable sync → generate a random AK + primary DEK `"0"` → wrap AK for this device and for the seed-derived recovery keypair → create canary + signing keypair → recovery key shown once. |
| **Additional device** | New device generates keys → waits for approval → a trusted device rewraps the AK for it (`approve`, signature-gated) → new device unwraps AK and stages the keyring. |
| **Returning device**  | Key pair present, AK missing → fetch own envelope → unwrap AK → stage keyring → sync resumes.                                                                    |
| **Recovery key**      | Enter 24-word phrase → seed → fetch `kdf_salt` → derive the recovery keypair → reject immediately if its public half doesn't match the stored one → unwrap the AK from `recovery_wrapped_ak` → verify canary → unwrap keyring (incl. `"v1"`) → new envelope for this device. |
| **Change phrase**     | `changeRecoveryPhrase`: new random AK **and** a new seed; re-wrap the **entire** keyring under the new AK; re-issue every device envelope; re-anchor the recovery slot to the new phrase; new canary + signing key; `key_version++`. 0 rows re-encrypted. The new phrase is shown once. |
| **Revoke device**     | Delete envelope + revoke sessions, then **rotate both AK and DEK in one atomic request** so the removed device is locked out of future keyring and data. The AK rotation re-anchors the recovery slot to the **existing** recovery public keys — after verifying their attestation — so the rotation is silent and the user's phrase keeps working. |
| **Migrate (v1 → v2)** | See below — seamless, data-preserving, never a reset.                                                                                                            |
| **Sign out**          | All local keys cleared (dynamic DEK ids enumerated, not a static list) → next sign-in is a new device.                                                            |

## Device–session binding

Trust operations — approve, deny, revoke, rotate, add a key, fetch the keyring — are only meaningful
if the backend knows **which device** is asking. Every client sends an `X-Device-ID` header, but a
header is client-set: on its own it is a claim, not an identity. `getCallerDevice` used to accept it
as long as it named a non-revoked device of the same account, so any authenticated session could act
as any device on that account (THU-873).

That mattered because of what sits behind it. The account signing key is derived from the canary and
a revoked device retains it (THU-872), so a challenge proof shows *account* key possession, never
*device* identity. Revocation deletes the sessions **linked** to the revoked device, and a session is
linked only at first registration — so a device whose session expired and re-authenticated held an
unlinked session that survived its own revocation. Naming a trusted sibling in the header was then
enough to take a `rotate` challenge, sign it with the retained key, and rotate the account key to one
the attacker chose, *after* being revoked.

**Every caller-resolving route now resolves the caller from `session.deviceId`** and rejects a header
that does not match it, fail-closed when the session is bound to nothing. The mismatch is checked
before the device lookup, so a session cannot probe which device ids exist on its own account.

That makes the session→device binding the authority, so the binding itself is authenticated. No
account-wide secret can do it — a revoked device holds the AK, DEK `"0"` and the signing key — and the
only per-device secret is the device's ECDH private key, whose public half the server already stores.
Hence a two-step handshake:

1. `GET /devices/me/bind-challenge` mints a single-use nonce (a `challenge_nonces` row with operation
   `bind`) and returns it **sealed** to the claimed device's `public_key`: ECDH-P256 ephemeral →
   HKDF-SHA256 → AES-GCM (`backend/src/lib/device-bind.ts`). Asking is harmless — anyone may name any
   device and learn nothing, because the reply is unreadable without that device's private key.
2. `POST /devices/me/bind` takes the opened nonce, consumes it, and links the session
   (`openBindNonce`, `src/crypto/device-bind.ts`).

`bind` is deliberately **not** a member of `challengeOperations`: that list gates
`GET /encryption/challenge`, which returns nonces in cleartext, and types `ChallengeProof`. Keeping
them disjoint means a bind nonce can never be minted in the clear nor replayed as a signature proof.
The handshake is ECDH-only by design — the sealed value is an ephemeral liveness nonce, not stored
ciphertext, so a hybrid KEM would buy no post-quantum property, and v1-era devices have no ML-KEM
public key and would be permanently unbindable.

Two client triggers, both calling the idempotent `ensureSessionBound` (deduped per bearer token):
app init runs it before `startKeyRequestResponder`, so a keyring fetch cannot 403 into a fail-closed
codec; and `useDeviceSessionBinding` re-runs it whenever the session id changes, which is what covers
re-authentication — that flow never reloads the page, so app-init binding alone would leave the device
locked out until the next launch.

`POST /devices` no longer links a session for an already-trusted device. That branch took an
unverified client-supplied id, so linking there was a rebind bypass that made the pin worthless. It
still links at **first registration**, where the device is created as pending and the link grants
nothing.

**The sync routes are pinned too.** `GET /powersync/token` and `PUT /powersync/upload` resolve their
device the same way, so a revoked device with a surviving unlinked session cannot name a trusted
sibling to keep reading or writing the stream. They answer with a distinct `DEVICE_NOT_BOUND` code
which is deliberately absent from `getCredentialsInvalidReason`: the client logs it quietly, defers
sync, and retries once `ensureSessionBound` completes — it must never be mistaken for a revocation,
which would trigger a full local reset. That matters because initial sync runs at init step 3, before
the bind at step 6a, so the launch right after a re-authentication legitimately sees one deferred
token fetch.

The cost to weigh: a future headless client that syncs data but holds no device keypair (a server-side
integration, an API-key job) cannot bind, and so cannot sync. That is now a deliberate constraint
rather than an accident — enrolling as a device with its own keypair is the supported path.

A keyless device (a bridge, or a v1 device that never published hybrid keys) cannot bind at all,
which is safe because nothing keyless reaches a caller-resolving route. An API-key/PAT session
likewise can never bind, so a pasteable secret can never drive a key operation.

## Verifying the recovery anchor

A phrase-preserving rotation has to learn the recovery public keys from somewhere, and the only
source is the server. Wrapping the new AK to them needs no private key — that is exactly what makes a
silent re-anchor possible, and it also means a **malicious or compelled server could substitute its
own recovery keypair** and receive the next AK, then recover the account with a phrase it chose. On
any routine device revoke, silently (THU-865).

The fix is not to remember the keys locally. A local pin wedges every other device after a
legitimate phrase change, and a device that holds no pin yet simply adopts whatever is served. The
keys are instead **authenticated against key material the server does not have**:

1. **Every write signs.** `completeFirstDeviceSetup`, `migrateToV2` and each AK rotation call
   `buildRecoverySlot`, which signs `userId ‖ kdf_salt ‖ recovery public keys` with the signing key
   derived from **that write's** canary secret, and stores it as `recovery_attestation`.
2. **Every phrase-preserving read verifies.** `readStoredRecoveryPlan` derives the signing *public*
   key locally — from `getCanarySecret`, i.e. unwrap DEK `"0"` under the local AK, then `verifyCanary`
   — and checks the signature before wrapping anything. It deliberately ignores the server's
   `signing_public_key` column; deriving the key locally is the whole point. A missing or failing
   attestation throws `RecoveryAnchorError` and wraps nothing.
3. **`changeRecoveryPhrase` verifies nothing**, because it mints the keys itself. That is also the
   un-wedge for a v2 account whose row predates the column: one phrase change writes a signed slot.

Two properties make this free of staleness handling. DEK `"0"`'s key material is immutable across AK
rotations and `getWrappedDek0` prefers the local copy, so a device holding *any* epoch's
`{AK, wrapped DEK 0}` recovers the **current** canary secret and derives the **current** signing key
— a device that legitimately missed a rotation still verifies. And the signing key is re-minted on
every AK rotation, so an attestation from an earlier epoch cannot verify at the current one; no
version field is needed for replay protection.

The payload encoder (`encodeRecoveryAttestationPayload`, `shared/e2ee-types.ts`) leads with a domain
tag. That is load-bearing: the challenge payload is `nonce ␟ operation ␟ deviceId` and the **nonce is
server-chosen**, so without separation a server could try to steer a harvested challenge signature
into the anchor check. Verification always **reconstructs** the payload from known values and never
parses a received one.

The backend only stores and serves the attestation. It requires its *presence*
(`assertRecoveryCoverage`), which is what lets the client fail closed with no legacy-tolerant branch,
but it does **not** verify the signature — it would be checking a value against a key from the same
request, so it could not detect the adversary it matters against.

**Residuals.** A server can *withhold* the attestation and thereby block AK rotation — degradation,
not takeover (THU-871). And because the signing key derives from the canary secret, a **revoked**
device retains DEK `"0"` and can still fetch the current canary (THU-872), so a server colluding
with a revoked device can forge an attestation; closing THU-872 closes this too.

## Migration (v1 → v2): absorb + permanent dual-read

Existing v1 accounts (single CK) migrate to the v2 keyring with **zero data loss** and no re-upload of existing rows:

1. **Absorb.** The first trusted, CK-holding device ("the migrator") unwraps the legacy CK from its v1 envelope (`unwrapLegacyCK`, sharing the same hybrid-envelope derivation) and inserts it into the keyring as the reserved, read-only **`"v1"` slot**.
2. **Mint + flip.** It mints a fresh primary DEK `"0"`, generates a new random AK, mints a new recovery phrase, wraps the keyring (both `"0"` and `"v1"`), writes an envelope for every trusted device **and for the new recovery keypair**, registers the signing key + `kdf_salt`, and calls `POST /v1/encryption/upgrade`. The server verifies a **CK-possession proof** (the migrator recovers `canarySecret` by a no-AAD CK decrypt of the stored canary; the server checks `hash(canarySecret) == canary_secret_hash`), validates envelope + key coverage (a keyring **must** include both `"0"` and `"v1"`), and **CAS-flips `scheme_version` 1 → 2** as the atomic last step. The recovery phrase is shown **only on HTTP 200**.
3. **Concurrent migrators** resolve by that CAS: one wins; a loser gets **409** and falls through to the follower path (fetches the winner's envelope). Nothing local is persisted before the 200, so a loser is cleanly re-classified.
4. **Followers** (`scheme_version == 2`, no local AK) fetch their envelope, unwrap the AK, stage the keyring (including the `"v1"` slot — followers never absorb), and run a continuity check that decrypts a synced legacy row via the `"v1"` slot.
5. **Dual-read is permanent.** Legacy `__enc:<iv>:<ct>` rows are decoded in place via the `"v1"` slot forever; there is no bulk re-upload and no v1-encode path. New writes are v2 from the first flip.

The `MIN_APP_VERSION` gate is set in the merge deploy so it is live before any client can flip an account, closing the window where a live v1 client could read a flipped account.

## Enterprise Key Escrow (POC)

An optional, operator-controlled **third recipient** for the AK (THU-804), alongside device envelopes and the recovery phrase. When `ORG_ESCROW_ENABLED=true`, every AK create/change (first-device setup, AK rotation, v1→v2 upgrade) must include an `orgEnvelope` — the new AK wrapped to the operator's P-256 public key — which the server upserts into the server-only `org_envelopes` table (one row per user) inside the same transaction.

**The operator key lives only in the client build** (`VITE_ORG_ESCROW_PUBLIC_KEY`), never on the server (THU-866). The server holds no escrow key material at all: `ORG_ESCROW_ENABLED` is its whole configuration surface, and its only job is to make the envelope mandatory so no account slips through unescrowed. What it stores is opaque ciphertext it cannot unwrap and cannot attribute to any particular key.

- **Envelope format** (ECDH-only, deliberately no ML-KEM hybrid for this recipient): `[0x01][ephemeral P-256 pubkey raw, 65B][AES-KW-wrapped AK, 40B]`, base64; derivation is ECDH → HKDF-SHA256 (`orgEscrowHkdfInfo`, salt = ephemeral pubkey) → AES-KW-256. Constants live in `shared/e2ee-types.ts`; the frontend wrap is `wrapAKForOrg` in `src/crypto/primitives.ts` (no unwrap exists in the app).
- **Enabling escrow forfeits the account's post-quantum protection.** The AK is wrapped independently per recipient and every copy opens the same key, so the account is only as strong as its *weakest* recipient. Device and recovery-slot envelopes are hybrid (ECDH + ML-KEM-768) and hold up against harvest-now-decrypt-later; the escrow envelope is classical P-256 alone. An adversary who captures an `org_envelopes` row and later runs a cryptographically-relevant quantum computer recovers the AK, hence every DEK, hence all of that user's data — the ML-KEM on the other envelopes buys nothing at that point. This is an accepted POC trade-off for operator-key simplicity (a plain P-256 keypair is generated, stored, and used offline with standard tooling); making escrow post-quantum means adding an ML-KEM half to the operator keypair and to the offline decrypt tool.
- **The escrow key is pinned at build time, and there is no discovery endpoint (THU-866).** `buildOrgEnvelope` reads `pinnedOrgEscrowPublicKey()` (`src/lib/org-escrow.ts` → `VITE_ORG_ESCROW_PUBLIC_KEY`) and wraps to that alone. No pin ⇒ no envelope, whatever the server says; a pin ⇒ always that key, so a lying server can neither redirect the AK to a key it holds nor suppress the operator's copy. `GET /v1/encryption/org-key` **was deleted**, along with the server's `ORG_ESCROW_PUBLIC_KEY` setting: an endpoint that serves a wrap target is a standing invitation to trust it, and the disclosure UI would want the *pinned* fingerprint anyway (computable client-side) rather than whatever the server claims. `GET /v1/config` still surfaces `orgEscrowEnabled` for UI purposes; no client path may drive the wrap target from it. Device approval never touches the org envelope (approval doesn't change the AK).
- **There is deliberately no fingerprint column.** `org_envelopes` once carried `key_fingerprint`, stamped by the server from its own config over an envelope it never validated — a label masquerading as evidence, and the source of the false assurance in THU-866 (an operator auditing it saw nothing wrong under a substitution). The server cannot do better: identifying which public key an ECDH envelope was wrapped to requires the private half. So the column is gone rather than mitigated. **The wrap target is proven by unwrapping**, in `scripts/org-escrow-decrypt.ts`, which is the only place the private key exists; a wrong key fails with a descriptive error. An operator holding several historical escrow keys tries each until one opens the row.
- **Recovery is out-of-band only**: `scripts/org-escrow-keygen.ts` generates the operator keypair (private half stays offline, never on the app server); `scripts/org-escrow-decrypt.ts` — given the private key and direct DB access — recovers the AK from `org_envelopes`, unwraps the DEK keyring, and decrypts a single cell (v2 with AAD, or legacy v1 via the `"v1"` slot).
- **Rollout order matters**: the envelope is REQUIRED once the flag is on, and only clients that carry the THU-804 wrap path **and pin a key** send one. So enabling escrow has two preconditions, not one: ship a client build carrying `VITE_ORG_ESCROW_PUBLIC_KEY`, raise `MIN_APP_VERSION` past it, and let clients roll over — *then* set `ORG_ESCROW_ENABLED`. Flip it earlier and every setup, rotate and upgrade 400s (`orgEnvelope is required when org escrow is enabled`) for any client without the pin, which after THU-866 includes current builds that simply were not built with one. Since the server holds no key, there is nothing to keep in sync and no startup validation of one — but a build pinning the WRONG key escrows to something the operator cannot open, and nothing detects that; the pin and the offline private key must be two halves of the same keypair. Rotating the operator key is a build-and-deploy event. A malformed pin fails loudly on the client at the first AK mint (`importOrgPublicKey` throws).
- **Non-goals (POC)**: end-user disclosure UI, backfill for pre-escrow accounts, revocation on disable (existing envelopes persist; an AK+DEK rotation while disabled leaves the stale envelope unusable), recovery audit trail, in-app admin decrypt.

See `docs/architecture/e2ee-org-escrow-poc-plan.md` (local scratch plan) for the full design rationale. `e2e/e2ee/org-escrow.spec.ts` proves the loop end to end: setup escrows the AK, the offline tool recovers a synced row's plaintext. `e2e/e2ee/attacks/org-key-substitution.spec.ts` is the counterpart gate: a server serving an attacker's escrow key must not redirect the escrow, and the operator's key must still recover the row.

## Adding a New Encrypted Column

Add the table and column name to `encryptedColumnsMap` in [src/db/encryption/config.ts](../../src/db/encryption/config.ts). The middleware handles every column in the map automatically — download decryption and upload encryption (which binds AAD from the row context).

## Key Files

| File                                | Role                                                                        |
| ----------------------------------- | --------------------------------------------------------------------------- |
| `shared/e2ee-types.ts`              | Cross-boundary contracts: wire prefixes, `encodeAAD`/`canaryAAD`, challenge payload, DTOs |
| `src/crypto/primitives.ts`          | AK/DEK primitives, hybrid AK wrap/unwrap, `unwrapLegacyCK`, AES-256-GCM + AAD |
| `src/crypto/key-storage.ts`         | IndexedDB key storage (AK + dynamic `thunderbolt_dek_{keyId}`, ML-KEM at rest) |
| `src/crypto/canary.ts`              | Canary create/verify, deterministic ECDSA signing keypair, `recoverCanarySecretV1` |
| `src/crypto/recovery-key.ts`        | Recovery seed ↔ BIP-39 mnemonic, `deriveRecoveryKeyPairFromSeed` (KDF)       |
| `src/db/encryption/wire-format.ts`  | v1/v2 wire parse/format + `isV2EncryptedValue` classifier                    |
| `src/db/encryption/config.ts`       | Encrypted columns map (single source of truth)                              |
| `src/db/encryption/codec.ts`        | Dual-read AES-GCM codec with a key_id-indexed keyring cache                  |
| `src/services/encryption.ts`        | Service layer: setup, approve, recover, rotate, migrator + follower          |
| `backend/src/api/encryption.ts`     | Backend API: keys, challenge, rotate, upgrade                                |
| `backend/src/db/encryption-schema.ts` | Server-only tables: `encryption_metadata`, `wrapped_keys`, `challenge_nonces`, `envelopes` |
| `backend/src/lib/canary.ts`         | ECDSA challenge verification + `/upgrade` possession-proof check             |

## Sync Pipeline Integration

Encryption is implemented as a PowerSync transform-middleware. On **Chrome/Edge/Firefox** it runs inside a custom SharedWorker so keys stay in one place across tabs; on **Safari and Tauri** it runs on the main thread. Because the worker has key material but no auth token, the main thread pre-stages the wrapped-DEK keyring (including `"v1"`) into IndexedDB on unlock and after rotations; on an unknown `key_id` the worker signals the main thread to refresh the AK / fetch the missing DEK rather than failing open. See [Multi-Device Sync](./multi-device-sync.md#two-sync-paths) and [powersync-sync-middleware.md](./powersync-sync-middleware.md).

## Testing

The end-to-end suite lives in `e2e/e2ee/` and runs against a real Postgres + PowerSync service:

```bash
bash scripts/run-e2ee-powersync.sh                       # full suite
bash scripts/run-e2ee-powersync.sh migration.spec.ts     # one spec
```

The script boots `powersync-service/docker-compose.yml` on dedicated ports (5434/8081) and runs `playwright.e2ee.config.ts`. `migration.spec.ts` seeds a real legacy v1 account (hybrid CK envelopes + `__enc:<iv>:<ct>` rows) and proves zero data loss across the migrator, a later-joining follower, and a fresh recovery, plus the concurrent-migrator CAS and the below-min 426 guard.
