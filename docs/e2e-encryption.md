# E2E Encryption

Thunderbolt uses zero-knowledge end-to-end encryption: all user data is encrypted client-side before upload and decrypted client-side after sync download. The server stores only ciphertext and wrapped keys — it cannot read user data even if compelled or breached.

Cryptographic primitives: **RSA-OAEP 2048-bit** device key pairs, **AES-256-GCM** content key (CK) with 12-byte random IV per field value. Authentication is email + 2FA. No additional passphrase or PIN. The **recovery key** (a 24-word BIP-39 mnemonic) is the only user-managed secret.

For the sync pipeline integration (how encrypted data flows through PowerSync), see [powersync-sync-middleware.md](powersync-sync-middleware.md).

---

## Key Concepts

| Concept | Description |
| --- | --- |
| **Device key pair** | Each device generates its own RSA-OAEP public/private key pair when the user first enables sync. The private key never leaves the device. Stored in IndexedDB as non-extractable CryptoKey. |
| **Content key (CK)** | A single AES-256-GCM key that encrypts all user data. Identical across all devices. Stored in IndexedDB as non-extractable CryptoKey after first setup. |
| **Device envelope** | CK wrapped with a specific device's public key. Stored server-side in a non-syncable table. Only that device's private key can unwrap it. |
| **Recovery key** | CK encoded as a 24-word BIP-39 mnemonic. Shown once at first setup. The only way to access data if all devices are lost. |
| **Canary** | A fixed plaintext (`thunderbolt-canary-v1`) encrypted with CK and stored server-side. Used to verify a recovery key is correct before creating a new envelope. Also used by the FE to detect whether encryption has been set up for an account (`GET /encryption/canary` returns 404 if not). |

---

## Key Hierarchy

Each device has its own private key. CK — which encrypts all data — is wrapped separately for each device using that device's public key. Each device unwraps its own envelope with its own private key and arrives at the same CK. Different paths, identical result. No device ever sees another device's private key. The server never sees any private key.

```
                         ┌─────────────────────────┐
                         │            CK            │
                         │  (one key, all records)  │
                         └────────────┬────────────┘
                    wrapped separately for each device
          ┌──────────────────┬─────────────────────┐
          ▼                  ▼                      ▼
 ┌────────────────┐ ┌────────────────┐   ┌────────────────┐
 │ envelope       │ │ envelope       │   │ envelope       │
 │ device 1       │ │ device 2       │   │ device 3       │
 │ (pub key 1)    │ │ (pub key 2)    │   │ (pub key 3)    │
 └───────┬────────┘ └───────┬────────┘   └───────┬────────┘
   unwrap with        unwrap with           unwrap with
   private key 1      private key 2         private key 3
          │                  │                      │
          ▼                  ▼                      ▼
         CK                 CK                     CK
      (identical)        (identical)            (identical)
```

---

## Why the Server Is Blind

The server stores encrypted records and device envelopes. It never holds the plaintext CK. To decrypt a record it would need to unwrap an envelope, which requires a private key. Private keys never leave devices. The decryption chain is permanently broken at step 1.

```
  ┌─────────────────────────────────────────────────────────┐
  │                        SERVER                           │
  │                                                         │
  │  ┌──────────────────────┐  ┌─────────────────────────┐ │
  │  │   data records       │  │   device envelopes      │ │
  │  │                      │  │                         │ │
  │  │  ciphertext ████████ │  │  wrapped CK             │ │
  │  │  iv (nonce)          │  │  device public key      │ │
  │  │  record_id           │  │  device_id, user_id     │ │
  │  └──────────────────────┘  └─────────────────────────┘ │
  │                                                         │
  │  ✗ missing: CK — never stored here in plaintext         │
  └─────────────────────────────────────────────────────────┘

  to decrypt a record, the server would need to:

  step 1: unwrap envelope → needs a private key     ← BLOCKED
  step 2: get CK          → only exists on device   ← unreachable
  step 3: decrypt record  → impossible without CK

  private keys never leave devices — chain is broken at step 1
```

---

## Encryption Round Trip

A record starts as plaintext, gets encrypted with CK before leaving the device, travels to the server as locked bytes, syncs to any other device, and is decrypted back to plaintext using CK unwrapped from that device's own envelope.

```
  YOUR DEVICE                              SERVER
  ─────────────────────────────────────    ──────────────────────

  plaintext record
       │
       │ encrypt with CK (AES-GCM, fresh IV)
       ▼
  { iv, ciphertext } ──── sync ────▶  { iv, ciphertext } stored
                                              │
                                              │ server tries to read:
                                              │ no CK → ✗ impossible
                                              │
  { iv, ciphertext } ◄──── sync ────────────┘
       │
       │ unwrap envelope with private key → CK
       │ decrypt { iv, ciphertext } with CK
       ▼
  plaintext record (identical to original)
```

---

## Data Model

Three server-side tables handle the encryption layer. Only `devices` is syncable via PowerSync. The other two are server-side only — never sent to any device.

### `devices` table — syncable

Synced to all trusted devices via PowerSync. Contains device identity — no key material except the public key (which is intentionally visible to all trusted devices for the approval flow).

| Column | Type | Notes |
| --- | --- | --- |
| `id` | text (PK) | Generated locally on FE at sign-in |
| `user_id` | text (FK → users) | |
| `name` | text | e.g. "Chrome on MacBook" (encrypted) |
| `trusted` | boolean | `false` = pending approval, `true` = has envelope and can sync. Revocation tracked by `revoked_at`. |
| `public_key` | text | Base64 RSA public key — set when user enables sync. `null` for pre-encryption devices. |
| `last_seen` | timestamp | |
| `created_at` | timestamp | |
| `revoked_at` | timestamp | When set, device is revoked regardless of `trusted` value. |

### `envelopes` table — server-side only

One row per trusted device. Each device fetches only its own row via API — never via PowerSync. Cascade-deletes when the device or user is deleted.

| Column | Type | Notes |
| --- | --- | --- |
| `device_id` | text (PK, FK → devices) | |
| `user_id` | text (FK → users) | Indexed for fast lookup |
| `wrapped_ck` | text | Base64 — CK wrapped with this device's public key |
| `created_at` | timestamp | |
| `updated_at` | timestamp | |

### `encryption_metadata` table — server-side only

One row per user account. Created at first device setup. Used for canary verification during recovery key entry, and to detect whether encryption has been set up for an account.

| Column | Type | Notes |
| --- | --- | --- |
| `user_id` | text (PK, FK → users) | |
| `canary_iv` | text | Base64 IV used to encrypt the canary |
| `canary_ctext` | text | Base64 AES-GCM ciphertext of `thunderbolt-canary-v1` |
| `created_at` | timestamp | |

> The canary is a fixed known plaintext encrypted with CK. When a user enters their recovery key, the FE decrypts the canary locally — confirming the key is correct before making any changes.

---

## Local Storage (Client-Side)

```
localStorage (non-sensitive state)
─────────────────────────────────────────────────────────────
thunderbolt_device_id       string    generated at sign-in, stable across sign-outs
powersync_sync_enabled      string    "true" | "false"

IndexedDB — database: thunderbolt-keys, store: keys
─────────────────────────────────────────────────────────────
thunderbolt_private_key     CryptoKey    extractable: false, usage: unwrapKey
thunderbolt_public_key      CryptoKey    extractable: false, usage: wrapKey
thunderbolt_ck              CryptoKey    extractable: false, usage: encrypt/decrypt/wrapKey
```

> **CK extractability exception:** During first device setup, CK is generated as an extractable key solely to encode the recovery key (BIP-39 mnemonic) and create the canary. It is immediately re-imported as non-extractable. The extractable version is never persisted and exists in memory only briefly.

---

## Device States

Devices use a `trusted` boolean and a `revoked_at` timestamp. The `trusted` column is synced via PowerSync so the frontend can show device states without querying server-only tables.

| State | Columns | Description |
| --- | --- | --- |
| Pending approval | `trusted = false`, `revoked_at = null` | Key pair generated and sent to server. Waiting for a trusted device to approve. |
| Trusted | `trusted = true`, `revoked_at = null` | Device has an envelope. CK available. Sync enabled. |
| Revoked | `revoked_at ≠ null` | Envelope deleted. Device can no longer decrypt data or receive sync updates. |

> **Note:** `trusted` is redundant with the `envelopes` table on the backend (a device is trusted iff it has an envelope). It exists solely as a sync signal for the frontend, which cannot query the server-only `envelopes` table.

---

## API Endpoints

### `POST /devices`

Register a device with its public key. Returns the device's current state.

**Body:** `{ deviceId, publicKey, name? }`

**Responses:**
- Device already trusted (has publicKey): `{ trusted: true, envelope: string | null }`
- Device not yet trusted (has publicKey): `{ trusted: false }`
- Pre-encryption device (no publicKey on server): re-registers with publicKey, returns `{ trusted: false }`
- Device revoked: `403 { error: "Device has been revoked" }`
- New device: creates row, returns `{ trusted: false }`

The FE then calls `GET /encryption/canary` to determine whether to generate CK locally (canary 404 = first device) or wait for approval (canary 200 = additional device).

### `POST /devices/:deviceId/envelope`

Store a wrapped CK for a device. Marks the device as trusted on success.

**Body:** `{ wrappedCK, canaryIv?, canaryCtext? }`
**Headers:** `X-Device-ID` (caller's device ID)

**Authorization logic** (inside transaction):
- **First device bootstrap:** no envelopes exist and caller is the device → allowed
- **Self-recovery:** caller is the device and provided canary matches stored metadata → allowed
- **Trusted device approving another:** caller must be trusted → allowed
- All other cases → `403`

Also stores canary in `encryption_metadata` if provided (idempotent — first device setup only).

### `GET /devices/me/envelope`

Fetch the calling device's own wrapped CK.

**Headers:** `X-Device-ID`

Returns `{ trusted, wrappedCK }` or `404` if no envelope exists (not yet approved).

### `GET /encryption/canary`

Fetch the canary for recovery key verification. Also used to detect whether encryption has been bootstrapped for an account.

Returns `{ canaryIv, canaryCtext }` or `404` if encryption not set up.

### `POST /v1/account/devices/:id/revoke`

Revoke a device. Runs in a transaction: deletes the device's envelope, then sets `revoked_at`. Returns `204`.

---

## Server Decision Logic

Two round trips drive the first-device flow. All other flows are a single round trip.

```
─── Round trip 1 ───────────────────────────────────────────────

POST /devices { deviceId, publicKey }

→ device already known, trusted, has publicKey
      returns { trusted: true, envelope }

→ device already known, not trusted, has publicKey
      returns { trusted: false }

→ device already known, no publicKey (pre-encryption device)
      re-registers with publicKey
      returns { trusted: false }

→ device unknown
      creates device row (trusted: false)
      returns { trusted: false }

FE then calls GET /encryption/canary:
  → 404 (no canary) → FE generates CK locally (first device)
  → 200 (canary exists) → FE waits for approval or uses recovery key

─── Round trip 2 (first device path only) ─────────────────────

POST /devices/:deviceId/envelope { wrappedCK, canaryIv, canaryCtext }

      stores wrappedCK in envelopes table
      stores canary in encryption_metadata
        (only if row does not yet exist for this user)
      marks device as trusted
      returns { trusted: true }
```

---

## User Flows

### Flow A — New User, No Account

1. User installs Thunderbolt and opens the app.
2. App operates in fully local mode. No auth, no sync, no encryption.
3. No device record on server. No key material anywhere.

### Flow B — User Signs In, Sync Disabled

1. User signs in via email + 2FA.
2. Device ID generated locally and stored in localStorage.
3. Sync remains OFF. Data stays local.
4. No key pair generated yet. No device record on server yet.

### Flow C — First Device (no canary exists)

Runs when the user enables sync and no canary exists for this account (meaning encryption has never been bootstrapped). CK is generated entirely on the FE — the server never sees it in plaintext.

1. User toggles "Enable Sync".
2. FE generates key pair → stores in IndexedDB (non-extractable).
3. FE sends `POST /devices { deviceId, publicKey }`.
4. Server returns `{ trusted: false }`.
5. FE calls `GET /encryption/canary` → 404 (no canary) → first device flow.
6. FE generates CK locally (extractable at this moment only).
7. FE encodes CK as BIP-39 24-word mnemonic → recovery key held in memory briefly.
8. FE encrypts `"thunderbolt-canary-v1"` with CK → `{ canaryIv, canaryCtext }`.
9. FE wraps CK with own public key via `SubtleCrypto.wrapKey` → `wrappedCK`.
10. FE sends `POST /devices/:deviceId/envelope { wrappedCK, canaryIv, canaryCtext }`.
11. Server stores envelope and canary → marks device trusted.
12. FE re-imports CK as non-extractable → stores in IndexedDB. Extractable version discarded.
13. Sync enabled. Data begins encrypting and uploading.
14. FE shows recovery key screen:

```
┌─────────────────────────────────────────────────────┐
│  Save your recovery phrase                           │
│                                                      │
│  Write down these 24 words in order and store them   │
│  somewhere safe. You'll need them to recover your    │
│  data if you lose access to all your devices.        │
│  This phrase won't be shown again.                   │
│                                                      │
│  abandon ability able about above absent ...          │
│                                                      │
│  [Copy to clipboard]                                 │
│  ☐ I have saved my recovery phrase                   │
│  [Done]                                              │
└─────────────────────────────────────────────────────┘
```

### Flow D — Additional Device (approval flow)

Runs when the user enables sync on a new device and a canary already exists (encryption was previously bootstrapped).

**On the new device (Device 2):**

1. User toggles "Enable Sync".
2. FE generates key pair → stores in IndexedDB (non-extractable).
3. FE sends `POST /devices { deviceId, publicKey }`.
4. Server returns `{ trusted: false }`.
5. FE calls `GET /encryption/canary` → 200 → additional device flow.
6. FE shows approval waiting screen with polling.

**On the trusted device (Device 1) — simultaneously:**

1. PowerSync delivers new untrusted device row to Device 1.
2. User opens Settings → Devices → sees pending device → taps "Approve".
3. FE reads Device 2's public key from the synced device row.
4. FE wraps CK with Device 2's public key via `SubtleCrypto.wrapKey`.
5. FE sends `POST /devices/:device2Id/envelope { wrappedCK }`.
6. Server stores Device 2's envelope → marks device trusted.

**Back on Device 2:**

1. Polling detects envelope via `GET /devices/me/envelope`.
2. FE unwraps envelope with private key → CK in memory.
3. FE re-imports CK as non-extractable → stores in IndexedDB.
4. Sync enabled.

> **Page refresh during approval:** The key pair persists in IndexedDB. On reload, `POST /devices` returns `{ trusted: false }` and the approval screen is shown again. Device 1 can still approve — the public key has not changed.

### Flow E — Recovery Key (no trusted device available)

Accessed via "Use recovery key instead" on the approval waiting screen.

1. User enters 24-word recovery phrase.
2. FE decodes mnemonic → raw CK bytes via BIP-39.
3. FE fetches canary: `GET /encryption/canary`.
4. FE decrypts canary locally:
   - Matches `"thunderbolt-canary-v1"` → proceed.
   - Fails → error: "Invalid recovery phrase."
5. FE registers device: `POST /devices { deviceId, publicKey }`.
6. FE wraps CK with own public key.
7. FE sends `POST /devices/:deviceId/envelope { wrappedCK, canaryIv, canaryCtext }`.
8. Server stores envelope (self-recovery path: canary match bypasses trusted-device check) → marks device trusted.
9. FE re-imports CK as non-extractable → stores in IndexedDB.
10. Sync enabled.

### Flow F — Returning Device (CK lost from IndexedDB)

Key pair still present, CK missing (e.g. partial storage clear).

1. App loads → CK not found → key pair found.
2. App sends `GET /devices/me/envelope`.
3. Server returns envelope (device is trusted).
4. FE unwraps → stores CK → sync resumes.

> If the key pair is also missing, treat as Flow H (data wipe).

### Flow G — Sign Out

1. User signs out.
2. FE clears CK from IndexedDB. Keeps key pair and device ID.
3. On next sign-in: `POST /devices` returns `{ trusted: true, envelope }` → CK restored.

> Sign-out is not a security boundary for the local device. To fully remove access, use Revoke.

### Flow H — Data Wipe / Browser Storage Cleared

All local data gone — device ID, key pair, CK.

1. User signs in → new device ID generated.
2. User enables sync → new key pair → `POST /devices` with new device ID.
3. Server sees unknown device → returns `{ trusted: false }`.
4. FE checks canary → 200 → additional device flow.
5. → Flow D (approval) or Flow E (recovery key).

> The old device record becomes orphaned and can be revoked from Settings → Devices.

### Flow I — Revoke a Device

1. User opens Settings → Devices → selects device → "Revoke".
2. `POST /v1/account/devices/:id/revoke` → transaction: delete envelope + set `revoked_at`.
3. PowerSync propagates the change.
4. Revoked device: server returns 403 → app clears CK, disables sync.

> Revoking does not change CK. Data already on the device remains locally readable until storage is cleared.

### Flow J — Change Email or 2FA

No impact on encryption. Device envelopes are tied to device key pairs, not credentials. All trusted devices remain trusted.

### Flow K — Pre-Encryption User Migration

Handles existing production users who enabled sync before E2E encryption was implemented. These users have devices in the table but no publicKey, no envelopes, and no canary.

1. App loads with sync ON + encryption enabled + no CK in IndexedDB.
2. FE detects migration state → auto-disables sync → opens encryption wizard.
3. FE calls `POST /devices { deviceId, publicKey }`.
4. Server detects pre-encryption device (no publicKey) → re-registers with publicKey → returns `{ trusted: false }`.
5. FE calls `GET /encryption/canary` → 404 → first device flow (Flow C).
6. User completes wizard → sync re-enabled with encryption.

**Multi-device race condition:** If two devices start the wizard simultaneously:
- Both see canary 404 → both attempt first device setup.
- The backend's transaction ensures only one succeeds (first to store an envelope wins).
- The second device gets 403 → FE re-checks canary → finds it → switches to additional device flow (Flow D/E).

---

## Encrypted Columns

Encryption is config-driven. A single source of truth in [src/db/encryption/config.ts](../src/db/encryption/config.ts) defines which columns are encrypted per table:

| Table | Encrypted columns |
| --- | --- |
| `settings` | `value` |
| `chat_threads` | `title` |
| `chat_messages` | `content`, `parts`, `cache`, `metadata` |
| `tasks` | `item` |
| `models` | `name`, `model`, `url`, `api_key`, `vendor`, `description` |
| `mcp_servers` | `name`, `url`, `command`, `args` |
| `prompts` | `title`, `prompt` |
| `triggers` | `trigger_time` |
| `model_profiles` | 12 columns (see config.ts) |
| `modes` | `name`, `label`, `icon`, `system_prompt` |
| `devices` | `name` |

**Wire format:** `__enc:<iv-base64>:<ciphertext-base64>`.

### Adding a new encrypted column

1. Add the column name to `encryptedColumnsMap` in `src/db/encryption/config.ts`.
2. That's it — both `EncryptionMiddleware` (download decryption) and `encodeForUpload` (upload encryption) read from this single config.

---

## CK Cache

The codec (`src/db/encryption/codec.ts`) lazy-loads CK from IndexedDB on first access and caches it in a module-scoped variable for the process lifetime. Call `invalidateCKCache()` on sign-out or full wipe so the codec reloads.

**SharedWorker consideration:** In Chrome/Edge/Firefox, the SharedWorker has its own module instance with its own `cachedCK`. `invalidateCKCache()` on the main thread does not reach the worker. The worker reloads from IndexedDB (which is cleared) on the next `getCK()` call, but there is a brief window where a stale CK could be used.

---

## Key Files

| File | Role |
| --- | --- |
| `src/crypto/primitives.ts` | RSA-OAEP and AES-256-GCM operations |
| `src/crypto/key-storage.ts` | IndexedDB key storage (key pair, CK) |
| `src/crypto/canary.ts` | Canary creation and verification |
| `src/crypto/recovery-key.ts` | BIP-39 mnemonic encoding/decoding |
| `src/db/encryption/config.ts` | Encrypted columns map (single source of truth) |
| `src/db/encryption/codec.ts` | AES-GCM codec with CK cache |
| `src/db/encryption/upload-encoder.ts` | Pre-upload column encryption |
| `src/services/encryption.ts` | Service layer orchestrating all flows |
| `src/api/encryption.ts` | Frontend API client |
| `src/hooks/use-sync-setup.ts` | Sync setup wizard state machine |
| `src/hooks/use-sync-enabled-toggle.ts` | Sync toggle + pre-encryption migration detection |
| `backend/src/api/encryption.ts` | Backend API routes |
| `backend/src/db/encryption-schema.ts` | `envelopes` and `encryption_metadata` tables |
| `backend/src/dal/encryption.ts` | Backend data access layer |

---

## At a Glance

| Scenario | Flow | Requires |
| --- | --- | --- |
| First device ever | C | Email + 2FA |
| Add new device (trusted device available) | D | Email + 2FA + approval from trusted device |
| Add new device (no trusted device) | E | Email + 2FA + recovery key |
| Returning device, CK lost | F | Email + 2FA (key pair still present) |
| Sign out and back in | G | Email + 2FA |
| Data wipe | H | Email + 2FA + approval or recovery key |
| Revoke a device | I | Email + 2FA |
| Change email or 2FA | J | Current credential verification |
| Pre-encryption user migration | K | Email + 2FA (auto-triggered) |

---

## Future Scope

| Feature | Notes |
| --- | --- |
| Key rotation | Generate new CK, re-wrap for all trusted devices, issue new recovery key, update canary. Not needed until a compromised CK is a realistic concern. |
| Content sharing | Per-record content keys wrapped for specific recipient devices. Requires architectural change — single CK model does not support selective sharing. |
| Platform keychain | Move key pair and CK from IndexedDB to OS keychain in native (Tauri) builds for hardware-backed protection. |
