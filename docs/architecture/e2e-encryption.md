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
| **DEK keyring**          | Versioned **AES-256-GCM** Data Encryption Keys (`key_id` `"0"`, `"1"`, …). Exactly one is `primary` (encrypts new writes); older DEKs are retained forever for reads.          |
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
| **Revoke device**     | Delete envelope + revoke sessions, then **rotate both AK and DEK** so the removed device is locked out of future keyring and data. The AK rotation re-anchors the recovery slot to the **existing** recovery public keys — after verifying their attestation — so the rotation is silent and the user's phrase keeps working. |
| **Migrate (v1 → v2)** | See below — seamless, data-preserving, never a reset.                                                                                                            |
| **Sign out**          | All local keys cleared (dynamic DEK ids enumerated, not a static list) → next sign-in is a new device.                                                            |

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

An optional, operator-controlled **third recipient** for the AK (THU-804), alongside device envelopes and the recovery phrase. When `ORG_ESCROW_ENABLED=true`, every AK create/change (first-device setup, AK rotation, v1→v2 upgrade) must include an `orgEnvelope` — the new AK wrapped to an operator-supplied P-256 public key (`ORG_ESCROW_PUBLIC_KEY`, base64 raw uncompressed point) — which the server upserts into the server-only `org_envelopes` table (one row per user) inside the same transaction. The server only ever holds the public half, so it cannot unwrap what it stores.

- **Envelope format** (ECDH-only, deliberately no ML-KEM hybrid for this recipient): `[0x01][ephemeral P-256 pubkey raw, 65B][AES-KW-wrapped AK, 40B]`, base64; derivation is ECDH → HKDF-SHA256 (`orgEscrowHkdfInfo`, salt = ephemeral pubkey) → AES-KW-256. Constants live in `shared/e2ee-types.ts`; the frontend wrap is `wrapAKForOrg` in `src/crypto/primitives.ts` (no unwrap exists in the app).
- **Enabling escrow forfeits the account's post-quantum protection.** The AK is wrapped independently per recipient and every copy opens the same key, so the account is only as strong as its *weakest* recipient. Device and recovery-slot envelopes are hybrid (ECDH + ML-KEM-768) and hold up against harvest-now-decrypt-later; the escrow envelope is classical P-256 alone. An adversary who captures an `org_envelopes` row and later runs a cryptographically-relevant quantum computer recovers the AK, hence every DEK, hence all of that user's data — the ML-KEM on the other envelopes buys nothing at that point. This is an accepted POC trade-off for operator-key simplicity (a plain P-256 keypair is generated, stored, and used offline with standard tooling); making escrow post-quantum means adding an ML-KEM half to the operator keypair and to the offline decrypt tool.
- **Discovery**: clients fetch `GET /v1/encryption/org-key` (`{ enabled, publicKey, fingerprint }`); `GET /v1/config` surfaces `orgEscrowEnabled`. Device approval never touches the org envelope (approval doesn't change the AK).
- **Recovery is out-of-band only**: `scripts/org-escrow-keygen.ts` generates the operator keypair (private half stays offline, never on the app server); `scripts/org-escrow-decrypt.ts` — given the private key and direct DB access — recovers the AK from `org_envelopes`, unwraps the DEK keyring, and decrypts a single cell (v2 with AAD, or legacy v1 via the `"v1"` slot).
- **Rollout order matters**: the envelope is REQUIRED once the flag is on, and only clients carrying the THU-804 wrap path send one. Flipping `ORG_ESCROW_ENABLED` on a deployment still serving older clients 400s every setup, rotate, and upgrade for them. Raise `MIN_APP_VERSION` past the escrow build and let clients roll over *before* enabling escrow. A malformed `ORG_ESCROW_PUBLIC_KEY` is caught at startup (settings `superRefine` → `validateOrgEscrowPublicKey`), so the boot fails loudly instead of every encryption write.
- **Non-goals (POC)**: end-user disclosure UI, backfill for pre-escrow accounts, revocation on disable (existing envelopes persist; an AK+DEK rotation while disabled leaves the stale envelope unusable), recovery audit trail, in-app admin decrypt.

See `docs/architecture/e2ee-org-escrow-poc-plan.md` (local scratch plan) for the full design rationale. `e2e/e2ee/org-escrow.spec.ts` proves the loop end to end: setup escrows the AK, the offline tool recovers a synced row's plaintext.

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
