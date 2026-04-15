# E2E Encryption

> ⚠️ **Note:** End-to-end encryption is under active development, has not yet undergone a cryptography audit, and is subject to further refinements.

Thunderbolt supports optional zero-knowledge end-to-end encryption: all user data is encrypted client-side before sync and decrypted client-side after download. The server stores only ciphertext and wrapped keys — it cannot read user data even if compelled or breached.

For the sync pipeline integration, see [powersync-sync-middleware.md](powersync-sync-middleware.md).

---

## Key Concepts

| Concept | Description |
| --- | --- |
| **Device key pair** | Each device generates an ECDH P-256 key pair and an ML-KEM-768 key pair when sync is enabled. Private keys never leave the device. |
| **Content key (CK)** | A single AES-256-GCM key that encrypts all user data. Identical across all devices. |
| **Device envelope** | CK wrapped using hybrid ECDH + ML-KEM for a specific device. Only that device's private keys can unwrap it. |
| **Recovery key** | CK encoded as a 24-word BIP-39 mnemonic. Shown once at first setup. The only way to recover data if all devices are lost. |
| **Canary** | A fixed plaintext encrypted with CK, stored server-side. Used to verify a recovery key is correct and to detect whether encryption has been set up for an account. |

---

## Key Hierarchy

Each device has its own private keys. CK is wrapped separately for each device using a hybrid envelope. Each device unwraps its own envelope to arrive at the same CK.

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
 └───────┬────────┘ └───────┬────────┘   └───────┬────────┘
   unwrap with        unwrap with           unwrap with
   private key 1      private key 2         private key 3
          │                  │                      │
          ▼                  ▼                      ▼
         CK                 CK                     CK
      (identical)        (identical)            (identical)
```

---

## User Flows

| Scenario | Description |
| --- | --- |
| **First device** | User enables sync → device generates key pair and CK → wraps CK for itself → recovery key shown once |
| **Additional device** | New device generates key pair → waits for approval → trusted device wraps CK for new device → new device unwraps and syncs |
| **Recovery key** | User enters 24-word phrase → CK decoded → canary verified → new envelope created → sync resumes |
| **Returning device** | Key pair still present, CK missing → fetches own envelope → unwraps → sync resumes |
| **Sign out** | All local keys cleared → next sign-in treated as a new device |
| **Revoke device** | Envelope deleted, `revoked_at` set → device can no longer decrypt or sync |

---

## Encrypted Columns

Encryption is config-driven. A single source of truth in [src/db/encryption/config.ts](../src/db/encryption/config.ts) defines which columns are encrypted per table.

**Wire format:** `__enc:<iv-base64>:<ciphertext-base64>`

To add a new encrypted column, add the column name to `encryptedColumnsMap` in the config file — both the download middleware and upload encoder read from it automatically.

---

## Key Files

| File | Role |
| --- | --- |
| `src/crypto/primitives.ts` | Hybrid key wrapping and AES-256-GCM operations |
| `src/crypto/key-storage.ts` | IndexedDB key storage |
| `src/crypto/canary.ts` | Canary creation and verification |
| `src/crypto/recovery-key.ts` | BIP-39 mnemonic encoding/decoding |
| `src/db/encryption/config.ts` | Encrypted columns map (single source of truth) |
| `src/db/encryption/codec.ts` | AES-GCM codec with CK cache |
| `src/services/encryption.ts` | Service layer orchestrating all flows |
| `backend/src/api/encryption.ts` | Backend API routes |
| `backend/src/dal/encryption.ts` | Backend data access layer |
