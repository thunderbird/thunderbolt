# End-to-End Encryption

> ⚠️ End-to-end encryption is in **Preview**. It has not yet undergone a cryptography audit and is subject to further refinements.

Thunderbolt supports zero-knowledge end-to-end encryption: all user data is encrypted client-side before sync and decrypted client-side after download. The server stores only ciphertext and wrapped keys — it cannot read user data even if compelled or breached.

This document describes **E2EE v2** — the AK/DEK key hierarchy with hybrid post-quantum device envelopes, AAD-bound versioned ciphertext, ECDSA challenge-response device management, and the **data-preserving v1 → v2 migration** (absorb + permanent dual-read). For the sync pipeline integration, see [powersync-sync-middleware.md](powersync-sync-middleware.md).

---

## Configuration

E2EE is **always on** — there is no toggle and no disabled state. Every device must complete the trust/envelope flow (setup wizard, key generation, device approval) before it is allowed to sync; the backend never auto-trusts a device or skips the envelope flow.

**`needsSyncSetupWizard()`** (`src/db/encryption/config.ts`) is the one gate, and it answers a purely local question: does this device hold an AK plus at least one wrapped DEK? It returns `true` — meaning "run the setup wizard" — only when that hierarchy is incomplete. Sign-in and the sync toggle both key off it.

A device with sync on but no key hierarchy has sync switched off automatically, so it can't upload data it is unable to encrypt; the user turns sync back on and the wizard takes over. That check waits on `init-gate.ts` for the boot-time v1 → v2 migration to settle first, since a device mid-migration has no AK yet and would otherwise be treated as unconfigured. If the gate times out the check does nothing rather than guessing — a slow migration must not be read as "never set up".

> Rolling this out to a deployment where encryption was previously optional is itself a hard cutover — old cached clients still expect the disabled behavior, and a stale bundle would upload plaintext for an account new clients treat as encrypted. Guard it behind `MIN_APP_VERSION`, the same app-version-gate mechanism used for the v1 → v2 migration cutover below, so stranded clients get a 426 instead. Rows written as plaintext before the cutover stay plaintext: dual-read passes them through indefinitely and there is no bulk re-encryption pass.

Optional, off by default: a deployment operator can additionally escrow a copy of every account key to a keypair they control — see [Enterprise KMS escrow](#enterprise-kms-escrow-poc) for how it works, and [self-hosting configuration](../self-hosting/configuration.md#enterprise-key-escrow-poc) for the `ORG_KMS_ESCROW_*` variables and what enabling them changes.

### Migration gate (`MIN_APP_VERSION`)

The v1 → v2 rollout is a **hard cutover** guarded by the app-version gate (`createAppVersionMiddleware`, mounted before auth in `backend/src/index.ts`). When `MIN_APP_VERSION` is set, every non-exempt `/v1` request from a below-minimum client (including `GET /v1/powersync/token`) is rejected with **426 Upgrade Required** — fail-closed, so a missing `X-App-Version` is also rejected. This prevents a live v1 client from syncing a flipped account with stale code. See [powersync-account-devices.md](powersync-account-devices.md) and the migration section below.

---

## Key Concepts

| Concept                | Description                                                                                                                                                                                        |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Device key pair**    | Each device generates an **ECDH P-256** key pair and an **ML-KEM-768** key pair. Private keys never leave the device. The ML-KEM secret is encrypted at rest (self-ECDH → HKDF).                   |
| **Account Key (AK)**   | An **AES-256** key with `wrapKey`/`unwrapKey` usages **only** — it never encrypts data; it is pure access control over the keyring. Derived from a 24-word recovery seed via PBKDF2-SHA512 (600k). |
| **DEK keyring**        | Versioned **AES-256-GCM** Data Encryption Keys (`key_id` `"0"`, `"1"`, …). Exactly one is `primary` (encrypts new writes); older DEKs are retained forever for reads.                              |
| **`"v1"` slot**        | A reserved, read-only DEK slot holding the **absorbed legacy CK** from a migrated account. Decrypts legacy `__enc:<iv>:<ct>` rows (no AAD) forever. Never encrypts. See migration.                 |
| **Device envelope**    | The **AK** wrapped for one device via a hybrid ECDH + ML-KEM envelope. (The stored column is still named `wrapped_ck` for wire compatibility — it carries the AK.)                                 |
| **Recovery key**       | The 256-bit recovery **seed** encoded as a **24-word BIP-39 mnemonic**. Shown once at setup/rotation/migration. `mnemonic → seed → KDF → AK`.                                                      |
| **Canary**             | A known prefix + secret encrypted under the **primary DEK** with `canaryAAD(userId, keyId)`. Verifies key material at unlock and seeds the challenge-response signing keypair.                     |
| **Challenge-response** | An ECDSA P-256 keypair **deterministically derived from the canary secret**. Every post-flip trust op (approve/deny/revoke/rotate/recover) is signature-gated by a single-use server nonce.        |

## Key Hierarchy

Two tiers: the AK gates the keyring; the primary DEK encrypts data. AK rotation and DEK rotation both re-encrypt **zero** data rows.

```
24-word BIP-39 recovery seed
        │  PBKDF2-SHA512, 600k iters, per-account kdf_salt
        ▼
       AK (Account Key, AES-256, wrapKey/unwrapKey only)
        │  wrapped per device via hybrid ECDH-P256 + ML-KEM-768 envelope
        │  AES-KW wraps ▼
   DEK keyring (versioned, AES-256-GCM)
        ├─ key_id "0"   (primary — encrypts new writes)
        ├─ key_id "1"…  (older DEK versions — retained for reads)
        └─ key_id "v1"  (reserved, read-only: the absorbed legacy CK)
        │  AES-256-GCM + AAD encrypts ▼
      column data
```

Each device unwraps its own envelope to arrive at the same AK, then unwraps the wrapped-DEK keyring under that AK.

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

| Scenario                      | What happens                                                                                                                                                         |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **First device**              | Enable sync → mint AK from a fresh seed + primary DEK `"0"` → wrap AK for this device → create canary + signing keypair → recovery key shown once.                   |
| **Additional device**         | New device generates keys → waits for approval → a trusted device rewraps the AK for it (`approve`, signature-gated) → new device unwraps AK and stages the keyring. |
| **Returning device**          | Key pair present, AK missing → fetch own envelope → unwrap AK → stage keyring → sync resumes.                                                                        |
| **Recovery key**              | Enter 24-word phrase → seed → fetch `kdf_salt` → derive AK → verify canary → unwrap keyring (incl. `"v1"`) → new envelope for this device.                           |
| **Change phrase (rotate AK)** | New seed → new AK; re-wrap the **entire** keyring under the new AK; re-issue every device envelope; new canary + signing key; `key_version++`. 0 rows re-encrypted.  |
| **Revoke device**             | Delete envelope + revoke sessions, then **rotate both AK and DEK** so the removed device is locked out of future keyring and data.                                   |
| **Migrate (v1 → v2)**         | See below — seamless, data-preserving, never a reset.                                                                                                                |
| **Sign out**                  | All local keys cleared (dynamic DEK ids enumerated, not a static list) → next sign-in is a new device.                                                               |

## Migration (v1 → v2): absorb + permanent dual-read

Existing v1 accounts (single CK) migrate to the v2 keyring with **zero data loss** and no re-upload of existing rows:

1. **Absorb.** The first trusted, CK-holding device ("the migrator") unwraps the legacy CK from its v1 envelope (`unwrapLegacyCK`, sharing the same hybrid-envelope derivation) and inserts it into the keyring as the reserved, read-only **`"v1"` slot**.
2. **Mint + flip.** It mints a fresh primary DEK `"0"`, mints a new AK + recovery phrase, wraps the keyring (both `"0"` and `"v1"`), writes an envelope for every trusted device, registers the signing key + `kdf_salt`, and calls `POST /v1/encryption/upgrade`. The server verifies a **CK-possession proof** (the migrator recovers `canarySecret` by a no-AAD CK decrypt of the stored canary; the server checks `hash(canarySecret) == canary_secret_hash`), validates envelope + key coverage (a keyring **must** include both `"0"` and `"v1"`), and **CAS-flips `scheme_version` 1 → 2** as the atomic last step. The recovery phrase is shown **only on HTTP 200**.
3. **Concurrent migrators** resolve by that CAS: one wins; a loser gets **409** and falls through to the follower path (fetches the winner's envelope). Nothing local is persisted before the 200, so a loser is cleanly re-classified.
4. **Followers** (`scheme_version == 2`, no local AK) fetch their envelope, unwrap the AK, stage the keyring (including the `"v1"` slot — followers never absorb), and run a continuity check that decrypts a synced legacy row via the `"v1"` slot.
5. **Dual-read is permanent.** Legacy `__enc:<iv>:<ct>` rows are decoded in place via the `"v1"` slot forever; there is no bulk re-upload and no v1-encode path. New writes are v2 from the first flip.

The `MIN_APP_VERSION` gate is set in the merge deploy so it is live before any client can flip an account, closing the window where a live v1 client could read a flipped account.

## Adding a New Encrypted Column

Add the table and column name to `encryptedColumnsMap` in [src/db/encryption/config.ts](../../src/db/encryption/config.ts). The middleware handles every column in the map automatically — download decryption and upload encryption (which binds AAD from the row context).

## Key Files

| File                                  | Role                                                                                                        |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `shared/e2ee-types.ts`                | Cross-boundary contracts: wire prefixes, `encodeAAD`/`canaryAAD`, challenge payload, DTOs                   |
| `src/crypto/primitives.ts`            | AK/DEK primitives, hybrid AK wrap/unwrap, `unwrapLegacyCK`, AES-256-GCM + AAD                               |
| `src/crypto/key-storage.ts`           | IndexedDB key storage (AK + dynamic `thunderbolt_dek_{keyId}`, ML-KEM at rest)                              |
| `src/crypto/canary.ts`                | Canary create/verify, deterministic ECDSA signing keypair, `recoverCanarySecretV1`                          |
| `src/crypto/recovery-key.ts`          | Recovery seed ↔ BIP-39 mnemonic, `deriveAKFromSeed` (KDF)                                                   |
| `src/db/encryption/wire-format.ts`    | v1/v2 wire parse/format + `isV2EncryptedValue` classifier                                                   |
| `src/db/encryption/config.ts`         | Encrypted columns map (single source of truth)                                                              |
| `src/db/encryption/codec.ts`          | Dual-read AES-GCM codec with a key_id-indexed keyring cache                                                 |
| `src/services/encryption.ts`          | Service layer: setup, approve, recover, rotate, migrator + follower                                         |
| `backend/src/api/encryption.ts`       | Backend API: keys, challenge, rotate, upgrade                                                               |
| `backend/src/db/encryption-schema.ts` | Server-only tables: `encryption_metadata`, `wrapped_keys`, `challenge_nonces`, `envelopes`, `org_envelopes` |
| `backend/src/lib/canary.ts`           | ECDSA challenge verification + `/upgrade` possession-proof check                                            |
| `src/db/encryption/init-gate.ts`      | One-shot gate ordering the sync-toggle check behind the boot-time v1 → v2 migration                         |
| `backend/src/lib/org-escrow.ts`       | Serves the operator's escrow public key + fingerprint (the app's only escrow capability)                    |
| `scripts/kms-escrow-decrypt.ts`       | Standalone operator decrypt tool for escrowed accounts (never used by the app)                              |

## Sync Pipeline Integration

Encryption is implemented as a PowerSync transform-middleware. On **Chrome/Edge/Firefox** it runs inside a custom SharedWorker so keys stay in one place across tabs; on **Safari and Tauri** it runs on the main thread. Because the worker has key material but no auth token, the main thread pre-stages the wrapped-DEK keyring (including `"v1"`) into IndexedDB on unlock and after rotations; on an unknown `key_id` the worker signals the main thread to refresh the AK / fetch the missing DEK rather than failing open. See [Multi-Device Sync](./multi-device-sync.md#two-sync-paths) and [powersync-sync-middleware.md](./powersync-sync-middleware.md).

## Enterprise KMS escrow (POC)

An optional, permanent **third recipient type** for the AK, alongside device envelopes and the recovery phrase: an escrow key the deployment's operator controls. The AK is pure access control (`wrapKey`/`unwrapKey` only), so adding this recipient re-uses the existing "wrap once per recipient" model — it mints one more wrapped copy of the AK and re-encrypts zero data. It is a single global boolean env toggle (`ORG_KMS_ESCROW_ENABLED`, default off); there is no multi-tenant/org config layer.

> **This is an exception to the zero-knowledge property described at the top of this page.** On a deployment with escrow enabled, the operator can decrypt any user's data out of band, and end users are not notified. Escrow also is **not** retroactive: only accounts that bootstrap, rotate or upgrade after the flag is enabled get an escrow copy, so enabling it on a live deployment covers nobody until each account next produces an AK.

Unlike device envelopes, the org envelope is **classical ECDH-P256 only** — no ML-KEM/post-quantum hybrid — a disclosed, deliberate downgrade for this one recipient:

```
[version 1B = 0x01][ephemeral ECDH-P256 pubkey raw, 65B][AES-KW-wrapped AK, 40B]     base64-encoded
```

derived via ephemeral ECDH-P256 `deriveBits` → HKDF-SHA256 (`info = "thunderbolt-org-kms-ak-wrap-v1"`, `salt = ephPubRaw`) → AES-KW-256 wrap. The frontend (`wrapAKForOrg` in `src/crypto/primitives.ts`) only ever wraps against the org's **public** key fetched from `GET /v1/encryption/org-key` — it never has an unwrap path, and the plaintext AK is never sent to any network service.

Every AK-producing operation — first-device bootstrap (`POST /v1/devices/:deviceId/envelope`), `POST /v1/encryption/rotate`, `POST /v1/encryption/upgrade` — carries an optional `orgEnvelope` field that becomes **required** when escrow is enabled: the server rejects a request that omits it, or whose envelope isn't the frozen shape above, with a 400. It is persisted into the server-only `org_envelopes` table (never synced) in the same transaction as the rest of that endpoint's writes:

```
org_envelopes:
  user_id              text PK, references user.id, onDelete cascade
  wrapped_ak           text not null      -- the envelope above, base64
  kms_key_fingerprint  text not null      -- base64(SHA-256(raw public key bytes)) — display/audit only
  created_at / updated_at
```

The **approval** branch of that same device endpoint (adding a second device) does not touch the escrow copy — approving a device doesn't change the AK. `GET /v1/encryption/org-key` returns `{ enabled, publicKey, fingerprint }` — `enabled: false` with the other two `null` when escrow is off. That response, not any cached client config, is what decides whether a client wraps.

**The app implements only the wrapping half.** `backend/src/lib/org-escrow.ts` reads the configured public key and fingerprints it; that is the entire server-side feature. The backend is never given the private key, so it cannot unwrap the envelopes already sitting in `org_envelopes`, and there is no provider abstraction because there is nothing to abstract over.

> That guarantee covers **stored** envelopes, not future ones. Clients wrap the AK against whatever key `GET /v1/encryption/org-key` returns and do not pin it, so a compromised backend can serve a key it controls — even on a deployment with escrow disabled — and harvest every AK minted from then on. Escrow does not create this exposure (a compromised backend can already serve malicious client code), but it does add a quiet, protocol-shaped way to use it. Pinning the escrow key out-of-band is a non-goal of this POC.

Unwrapping is a separate, out-of-band operator concern. `scripts/kms-escrow-decrypt.ts` ships as a working reference: it connects straight to Postgres, takes the private key from `$ORG_KMS_ESCROW_STATIC_PRIVATE_KEY` or `--static-private-key-file` (never argv), unwraps the AK, unwraps just the DEK that row needs, and prints one column of one row. An operator whose private key lives somewhere that script can't reach — an HSM, a KMS, a split-custody scheme — replaces its `deriveSharedSecret` step with their own key-agreement call, or reimplements the chain entirely from the envelope format above. Nothing in the app changes either way, which is why the app carries no code for it.

This is a POC — explicit non-goals for now: a disclosure/consent UI shown to end users when escrow is enabled, a backfill for accounts that predate enabling it, an escrow-disable → AK+DEK rotation flow (device-revocation-equivalent), an escrow-key-rotation → re-wrap-org-envelope flow, first-class support for KMS/HSM-resident escrow keys, an audit trail of recoveries (with an operator-held key, nothing in this system records that a decrypt happened), and an in-app admin-decrypt feature (decryption stays a standalone, out-of-band tool, not a backend endpoint).

## Testing

The end-to-end suite lives in `e2e/e2ee/` and runs against a real Postgres + PowerSync service:

```bash
bash scripts/run-e2ee-powersync.sh                       # full suite
bash scripts/run-e2ee-powersync.sh migration.spec.ts     # one spec
```

The script boots `powersync-service/docker-compose.yml` on dedicated ports (5434/8081) and runs `playwright.e2ee.config.ts`, which enables escrow for the **whole** suite (`ORG_KMS_ESCROW_ENABLED=true`) against a keypair generated per run — so every AK-producing flow exercises the escrow path incidentally, while `org-escrow.spec.ts` asserts the envelope itself and drives `scripts/kms-escrow-decrypt.ts` end to end. `migration.spec.ts` seeds a real legacy v1 account (hybrid CK envelopes + `__enc:<iv>:<ct>` rows) and proves zero data loss across the migrator, a later-joining follower, and a fresh recovery, plus the concurrent-migrator CAS and the below-min 426 guard.
