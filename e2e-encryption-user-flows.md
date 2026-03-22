# E2E Encryption User Flows

## Key Concepts

| Concept | Description |
| --- | --- |
| **Device key pair** | Each device generates its own public/private key pair when the user first enables sync. The private key never leaves the device. Stored in IndexedDB as non-extractable CryptoKey. |
| **Content key (CK)** | A single AES-256-GCM key that encrypts all user data. Identical across all devices. Stored in IndexedDB as non-extractable CryptoKey after first setup. |
| **Device envelope** | CK wrapped with a specific device's public key. Stored server-side in a non-syncable table. Only that device's private key can unwrap it. |
| **Recovery key** | CK encoded as a 64-char hex string. Shown once at first setup. The only way to access data if all devices are lost. Never shown again. |
| **Canary** | A fixed plaintext encrypted with CK and stored server-side. Used to verify a recovery key is correct before creating a new envelope. |

---

## How It Works — Visual Guide

The three diagrams below explain the encryption model: how keys are structured, why the server can never read your data, and how a record travels from your device to the server and back.

---

### Diagram 1 — Key hierarchy

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

### Diagram 2 — Why the server is blind

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

### Diagram 3 — Full encryption round trip

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

Three server-side tables handle the encryption layer. Only the `devices` table is syncable via PowerSync. The other two are server-side only — never sent to any device.

---

### `devices` table — syncable

Synced to all trusted devices via PowerSync. Contains device identity and status only — no key material.

```
devices
─────────────────────────────────────────────────────────────
device_id       string    PK — generated locally on FE at sign-in
user_id         string    FK → users
name            string    e.g. "Chrome on MacBook"
status          enum      APPROVAL_PENDING | TRUSTED | REVOKED
public_key      string    base64 — set when user enables sync
created_at      timestamp
last_seen_at    timestamp
```

> Public key is visible to all trusted devices via sync — this is intentional. Trusted devices need the public key to wrap CK during the approval flow.
> 

---

### `envelopes` table — server-side only, never synced

One row per trusted device. Each device fetches only its own row via a direct API call — never via PowerSync.

```
envelopes
─────────────────────────────────────────────────────────────
device_id       string    PK, FK → devices
user_id         string    FK → users
wrapped_ck      string    base64 — CK wrapped with this device's public key
created_at      timestamp
updated_at      timestamp
```

> Never synced. Never sent to any device except the one it belongs to. A device can only fetch its own envelope — the API enforces this.
> 

---

### `encryption_metadata` table — server-side only, never synced

One row per user account. Created at first device setup. Used for canary verification during recovery key entry.

```
encryption_metadata
─────────────────────────────────────────────────────────────
user_id         string    PK, FK → users
canary_iv       string    base64 — IV used to encrypt the canary
canary_ctext    string    base64 — AES-GCM encryption of "thunderbolt-canary-v1" with CK
created_at      timestamp
```

> The canary is a fixed known plaintext encrypted with CK. When a user enters their recovery key, the FE decrypts the canary locally before uploading any envelope — confirming the key is correct before making any changes.
> 

---

## Local Storage (Client-Side)

```
localStorage (non-sensitive state)
─────────────────────────────────────────────────────────────
thunderbolt_device_id       string    generated at sign-in, stable across sign-outs
thunderbolt_sync_enabled    string    "true" | "false"

IndexedDB (key material — all non-extractable CryptoKey objects)
─────────────────────────────────────────────────────────────
thunderbolt_private_key     CryptoKey    extractable: false, usage: unwrapKey
thunderbolt_public_key      CryptoKey    extractable: false, usage: wrapKey
thunderbolt_ck              CryptoKey    extractable: false, usage: encrypt/decrypt/wrapKey
```

> **CK exception:** During Flow C (first device setup), CK is generated as an extractable key solely to encode the recovery key for display and to create the canary. It is immediately re-imported as non-extractable after those operations. The extractable version is never persisted anywhere and exists in memory only for those few milliseconds.
> 

---

## Server API Endpoints

```
POST   /devices { deviceID, publicKey }
       → creates or identifies device row
       → returns status: FIRST_DEVICE | APPROVAL_PENDING | TRUSTED
       → returns envelope only if status is TRUSTED

POST   /devices/:deviceID/envelope { wrappedCK, canary_iv, canary_ctext }
       → stores envelope in envelopes table
       → stores canary in encryption_metadata (first device only — idempotent check)
       → updates device status to TRUSTED
       → callable by the device itself (FIRST_DEVICE path)
         or by a TRUSTED device on behalf of another (approval path)

GET    /devices/me/envelope
       → returns calling device's own envelope only (enforced server-side)
       → used in Flow D Continue check and Flow F CK recovery

GET    /encryption/canary
       → returns { canary_iv, canary_ctext } for the current user
       → used by FE to verify recovery key before uploading envelope (Flow E)

DELETE /devices/:deviceID
       → revokes device, deletes its envelope, updates status to REVOKED
```

---

## Device States

| State | Description |
| --- | --- |
| `APPROVAL_PENDING` | Key pair generated and sent to server. Waiting for a trusted device to approve. |
| `TRUSTED` | Device has an envelope. CK available. Sync enabled. |
| `REVOKED` | Envelope deleted. Device can no longer decrypt data or receive sync updates. |

---

## Server Decision Logic

Two round trips drive the first-device flow. All other flows are a single round trip.

```
─── Round trip 1 ───────────────────────────────────────────────

POST /devices { deviceID, publicKey }

→ device already known, status TRUSTED
      returns { status: TRUSTED, envelope }

→ device already known, status APPROVAL_PENDING
      returns { status: APPROVAL_PENDING, firstDevice: false }

→ device unknown, envelopes exist for this user
      creates device row (APPROVAL_PENDING)
      returns { status: APPROVAL_PENDING, firstDevice: false }

→ device unknown, NO envelopes exist for this user
      creates device row (APPROVAL_PENDING)
      returns { status: APPROVAL_PENDING, firstDevice: true }
      ← FE detects firstDevice: true and generates CK entirely on the client

─── Round trip 2 (firstDevice: true path only) ─────────────────

POST /devices/:deviceID/envelope { wrappedCK, canary_iv, canary_ctext }

      stores wrappedCK in envelopes table
      stores canary in encryption_metadata
        (only if encryption_metadata row does not yet exist for this user —
         guards against duplicate canary on concurrent requests)
      updates device status to TRUSTED
      returns { status: TRUSTED }
```

> **Fully zero-knowledge:** The server never generates, holds, or sees plaintext CK at any point. CK is generated on the FE, wrapped on the FE, and only the wrapped form ever reaches the server.
> 

---

## Authentication

All flows require the user to be signed in via email + 2FA. There is no passphrase, no PIN, and no additional credential for the user to manage day-to-day. The recovery key is the only user-managed secret and is only needed in emergencies.

---

## Flow A — New User, No Account

1. User installs Thunderbolt and opens the app.
2. App operates in fully local mode. No auth, no sync, no encryption required.
3. No device record on server. No key material anywhere.

---

## Flow B — User Signs In, Sync Disabled

1. User signs in via email + 2FA.
2. Device ID generated locally and stored in localStorage.
3. Sync remains OFF. Data stays local.
4. No key pair generated yet. No device record on server yet.
5. User can see "Enable Sync" toggle in Settings.

---

## Flow C — First Device Ever (firstDevice: true)

Runs when the user enables sync and no envelopes exist for this account. CK is generated entirely on the FE — the server never sees it in plaintext.

1. User toggles "Enable Sync".
2. FE generates key pair locally → stores in IndexedDB (non-extractable).
3. FE sends `POST /devices { deviceID, publicKey }`.
4. Server detects no existing envelopes → returns `{ status: APPROVAL_PENDING, firstDevice: true }`.
5. FE detects `firstDevice: true` → generates CK locally (extractable at this moment only).
6. FE encodes CK as 64-char hex → recovery key held in memory briefly.
7. FE encrypts `"thunderbolt-canary-v1"` with CK → `{ canary_iv, canary_ctext }`.
8. FE uses `SubtleCrypto.wrapKey` to wrap CK with own public key → `wrappedCK`.
*(Raw CK bytes handled inside browser's crypto engine — never exposed to JS after this point.)*
9. FE sends `POST /devices/:deviceID/envelope { wrappedCK, canary_iv, canary_ctext }`.
10. Server stores envelope in `envelopes` table and canary in `encryption_metadata` → marks device `TRUSTED` → returns `{ status: TRUSTED }`.
11. FE re-imports CK as non-extractable → stores in IndexedDB. Extractable version discarded.
12. Sync enabled. Data begins encrypting and uploading in background.
13. FE shows recovery key screen (final informational step — sync already active):

```
┌─────────────────────────────────────────────────────┐
│  Save your recovery key                              │
│                                                      │
│  Sync is now active. This is the only way to         │
│  recover your data if you lose all your devices.     │
│  We will never show this again.                      │
│                                                      │
│  a1b2c3d4 e5f6a7b8 c9d0e1f2 g3h4i5j6 ...            │
│                                                      │
│  [Copy to clipboard]                                 │
│                                                      │
│  [Done]  ← dismisses regardless                      │
└─────────────────────────────────────────────────────┘
```

> **Recovery key:** CK encoded as 64-char hex. Skipping this screen means permanent data loss if all devices are lost. The app cannot show it again.
> 

> **Fully zero-knowledge:** CK is generated on the FE, the canary is created on the FE, and only the wrapped envelope and encrypted canary are sent to the server. The server never sees plaintext CK at any point.
> 

---

## Flow D — Additional Device, Approval Flow (firstDevice: false)

Runs when the user enables sync on a new device and trusted devices already exist.

**On the new device (Device 2):**

1. User toggles "Enable Sync".
2. FE generates key pair → stores in IndexedDB (non-extractable).
3. FE sends `POST /devices { deviceID, publicKey }`.
4. Server detects existing envelopes, unknown device → creates device record with `APPROVAL_PENDING` → returns `{ status: APPROVAL_PENDING, firstDevice: false }`.
5. FE detects `firstDevice: false` → shows approval waiting screen:

```
┌─────────────────────────────────────────────────────┐
│  Approve this device                                 │
│                                                      │
│  Open Thunderbolt on one of your trusted devices     │
│  and go to Settings → Devices to approve             │
│  this device.                                        │
│                                                      │
│  Don't have another device?                          │
│  → Use recovery key instead                          │
│                                                      │
│  ☐  I have approved this device on another device    │
│                                                      │
│  [Continue]  ← disabled until checkbox ticked        │
└─────────────────────────────────────────────────────┘
```

**On the trusted device (Device 1) — simultaneously:**

1. PowerSync delivers new `APPROVAL_PENDING` device row to Device 1.
2. Badge appears on Settings → Devices nav item.
3. User opens Settings → Devices → sees pending device.
4. User taps "Approve":
    - FE reads Device 2's public key from the synced device row.
    - FE uses `SubtleCrypto.wrapKey` to wrap CK with Device 2's public key.
    *(CK is non-extractable — `wrapKey` handles this inside the browser's crypto engine, raw bytes never exposed to JS.)*
    - FE sends `POST /devices/:device2id/envelope { wrappedCK }`.
    - Server stores Device 2's envelope → updates status to `TRUSTED`.

**Back on Device 2:**

1. User ticks checkbox → taps Continue.
2. FE sends `GET /devices/me/envelope`.
3. Server response:
    - `TRUSTED` + envelope received:
        - FE unwraps envelope with private key → CK in memory.
        - FE re-imports CK as non-extractable → stores in IndexedDB.
        - Sync enabled. Encrypted data syncs down and decrypts locally.
    - Still `APPROVAL_PENDING`:
        - Show message: "Not approved yet. Check your other device and try again."
        - Checkbox resets. User can retry.

> **Page refresh during approval:** If Device 2 refreshes while waiting, the key pair persists in IndexedDB unchanged. On reload, FE sends `POST /devices` with the same deviceID and public key. Server returns `APPROVAL_PENDING` and the approval screen is shown again. Device 1 can still approve — the public key has not changed.
> 

---

## Flow E — Additional Device, No Trusted Device Available (Recovery Key)

Runs when the user enables sync on a new device but has no other trusted device — accessed via "Use recovery key instead" on the approval screen.

1. User taps "Use recovery key instead".
2. FE shows recovery key entry screen.
3. User enters 64-char hex recovery key.
4. FE decodes hex → raw CK bytes.
5. FE fetches canary from server: `GET /encryption/canary` → `{ canary_iv, canary_ctext }`.
6. FE decrypts canary locally using entered CK:
    - Decryption succeeds and plaintext matches `"thunderbolt-canary-v1"` → key is correct, proceed.
    - Decryption fails or plaintext does not match → show error: "Recovery key is incorrect. Please check and try again." → retry.
7. FE imports CK as non-extractable CryptoKey → stores in IndexedDB.
8. FE uses `SubtleCrypto.wrapKey` to wrap CK with device's own public key.
9. FE sends `POST /devices/:deviceID/envelope { wrappedCK }`.
10. Server stores envelope → updates device status to `TRUSTED`.
11. Sync enabled. Encrypted data syncs down and decrypts locally.

> **Canary verification happens entirely on the FE.** The server returns the canary blob but cannot decrypt it — it has no CK. The FE verifies locally before uploading anything, ensuring no garbage envelope is created on the server.
> 

> **Zero-knowledge:** The server only ever receives CK already wrapped with this device's public key. It never sees plaintext CK at any point in this flow.
> 

---

## Flow F — Returning Device, CK Lost from IndexedDB

Runs when a trusted device's CK is missing from IndexedDB but the key pair is still present — e.g. partial storage clear.

1. App loads → checks IndexedDB for CK → not found.
2. App checks IndexedDB for key pair → found.
3. App sends `GET /devices/me/envelope`.
4. Server finds device is `TRUSTED` → returns envelope.
5. FE unwraps envelope with private key → CK in memory.
6. FE re-imports CK as non-extractable → stores in IndexedDB.
7. App loads normally. Sync resumes.

> If the key pair is also missing, the device ID is gone too — treat as a full data wipe and apply Flow H.
> 

---

## Flow G — Sign Out

1. User signs out.
2. FE clears session token and CK from IndexedDB.
3. FE keeps device ID in localStorage and key pair in IndexedDB.
4. On next sign-in:
    - FE sends `POST /devices { deviceID, publicKey }`.
    - Server returns `{ status: TRUSTED, envelope }`.
    - FE unwraps envelope → CK restored → sync resumes.

> Sign-out is not a security boundary for the local device — the key pair persists. To fully remove access, use Settings → Devices → Revoke this device.
> 

---

## Flow H — Data Wipe / Browser Storage Cleared

All IndexedDB and localStorage data gone — device ID, key pair, CK — everything.

1. App loads → nothing found locally.
2. User signs in → new device ID generated.
3. User enables sync → new key pair generated → `POST /devices` with new device ID.
4. Server sees unknown device, existing envelopes → `APPROVAL_PENDING`.
5. → Flow D (approval from trusted device) or Flow E (recovery key) applies.

> The old device record becomes orphaned on the server. It will appear in Settings → Devices as an unrecognised device and can be revoked.
> 

---

## Flow I — Revoke a Device

1. User opens Settings → Devices → selects device → "Revoke".
2. Server deletes device's row from `envelopes` table → updates device status to `REVOKED`.
3. PowerSync propagates the status change to all trusted devices.
4. On the revoked device's next request:
    - Server returns 403.
    - App disables sync, clears CK from IndexedDB.
    - Shows: "This device has been revoked. Re-enable sync from a trusted device."

> Revoking does not change CK. Data already on the device remains locally readable until storage is cleared. If the device was stolen or compromised, consider a key rotation (future scope) to generate a new CK.
> 

---

## Flow J — Change Email or 2FA

1. User initiates credential change via account settings (standard auth flow).
2. Requires verification of current credential before updating.
3. No impact on encryption — device envelopes are tied to device key pairs, not credentials.
4. All trusted devices remain trusted after the change.

> Authentication credentials and encryption keys are fully independent. Changing your email or 2FA does not affect CK, device envelopes, or any device's ability to decrypt data.
> 

---

## Future Scope

| Feature | Notes |
| --- | --- |
| Key rotation | Generate new CK, re-wrap for all trusted devices, issue new recovery key, update canary. Not needed until a compromised CK is a realistic concern. |
| Content sharing | Per-record content keys wrapped for specific recipient devices. Requires architectural change — single CK model does not support selective sharing. |
| Platform keychain | Move key pair and CK from IndexedDB to OS keychain in native (Electron / Tauri) builds for hardware-backed protection. |

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