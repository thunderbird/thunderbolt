# End-to-End Encryption

> **Caution.** End-to-end encryption is in **Preview**. It has not yet undergone a cryptography audit and is subject to further refinements.

When E2E encryption is enabled, all user data is encrypted client-side before sync and decrypted client-side after download. The server stores only ciphertext and wrapped keys — it cannot read user data even if compelled or breached.

## Key Concepts

| Concept              | Description                                                                                                                                         |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Device key pair**  | Each device generates an **ECDH P-256** key pair and an **ML-KEM-768** key pair when sync is enabled. Private keys never leave the device.          |
| **Content key (CK)** | A single **AES-256-GCM** key that encrypts all user data. Identical across all devices of the same user.                                            |
| **Device envelope**  | The CK wrapped using hybrid ECDH + ML-KEM for a specific device. Only that device's private keys can unwrap it.                                     |
| **Recovery key**     | CK encoded as a **24-word BIP-39 mnemonic**. Shown once at first setup. The only way to recover data if all devices are lost.                       |
| **Canary**           | A fixed plaintext encrypted with CK, stored server-side. Used to verify a recovery key is correct and to detect whether encryption is set up.       |

## Key Hierarchy

There's one content key per account. Each device has its own keypair. The CK is wrapped separately for every device using a hybrid envelope. Each device unwraps its own envelope to arrive at the same CK.

```
                         ┌─────────────────────────┐
                         │            CK           │
                         │  (one key, all records) │
                         └───────────┬─────────────┘
                    wrapped separately for each device
          ┌──────────────────┬──────────────────┬─────┐
          ▼                  ▼                  ▼
 ┌────────────────┐ ┌────────────────┐ ┌────────────────┐
 │ envelope       │ │ envelope       │ │ envelope       │
 │ device 1       │ │ device 2       │ │ device 3       │
 └───────┬────────┘ └───────┬────────┘ └───────┬────────┘
  unwrap with       unwrap with        unwrap with
  private key 1     private key 2      private key 3
          │                  │                  │
          ▼                  ▼                  ▼
          CK                 CK                 CK
      (identical)       (identical)        (identical)
```

## Wire Format

Encrypted column values on the wire are written as:

```
__enc:<iv-base64>:<ciphertext-base64>
```

The download and upload middleware both read from `encryptedColumnsMap` in [src/db/encryption/config.ts](../src/db/encryption/config.ts) — a single source of truth for which columns are encrypted.

## User Flows

| Scenario              | What happens                                                                                                                       |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| **First device**      | User enables sync → device generates key pair and CK → wraps CK for itself → recovery key is shown once.                           |
| **Additional device** | New device generates its own keys → waits for approval → a trusted device wraps CK for it → new device unwraps and starts syncing. |
| **Returning device**  | Key pair still present locally, CK missing → fetches own envelope → unwraps → sync resumes.                                        |
| **Recovery key**      | User enters 24-word phrase → CK decoded → canary verified → new envelope created for this device → sync resumes.                   |
| **Sign out**          | All local keys cleared → next sign-in is treated as a new device.                                                                  |
| **Revoke device**     | Envelope deleted server-side, `revoked_at` set → device can no longer decrypt or sync.                                             |

## Adding a New Encrypted Column

To encrypt a new column, add the table and column name to `encryptedColumnsMap` in [src/db/encryption/config.ts](../src/db/encryption/config.ts). The existing `encryptionMiddleware` handles every column in the map automatically — both download decryption and upload encryption.

## Key Files

| File                            | Role                                           |
| ------------------------------- | ---------------------------------------------- |
| `src/crypto/primitives.ts`      | Hybrid key wrapping + AES-256-GCM primitives   |
| `src/crypto/key-storage.ts`     | IndexedDB-backed key storage                   |
| `src/crypto/canary.ts`          | Canary creation and verification               |
| `src/crypto/recovery-key.ts`    | BIP-39 mnemonic encode/decode                  |
| `src/db/encryption/config.ts`   | Encrypted columns map (single source of truth) |
| `src/db/encryption/codec.ts`    | AES-GCM codec with CK cache                    |
| `src/services/encryption.ts`    | Service layer orchestrating all flows          |
| `backend/src/api/encryption.ts` | Backend encryption API routes                  |
| `backend/src/dal/encryption.ts` | Backend data access layer                      |

## Sync Pipeline Integration

Encryption is implemented as a PowerSync transform-middleware. On **Chrome/Edge/Firefox** it runs inside a custom SharedWorker so the CK stays in one place across tabs; on **Safari and Tauri** it runs on the main thread because those environments don't support SharedWorker. See [Multi-Device Sync](./multi-device-sync.md#two-sync-paths) and [powersync-sync-middleware.md](./powersync-sync-middleware.md) for the full architecture.
