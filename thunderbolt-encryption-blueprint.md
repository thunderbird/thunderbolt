# Thunderbolt — E2E Encryption Implementation Blueprint

> **Audience:** Claude Code (or any engineer picking this up cold).
> **Scope:** Phases 1 and 2. Phase 3 stubs are included so the architecture is ready without any implementation work blocking a future sprint.
> **Stack assumption:** TypeScript, browser-native Web Crypto API (`window.crypto.subtle`). No third-party crypto libraries.

---

## 1. Guiding Principles

Before writing any code, internalise these — they are the constraints every decision flows from.

**1. Envelope encryption everywhere.**
Content is never encrypted directly with the master key. Every record gets its own ephemeral content key. The master key only ever wraps (encrypts) content keys. This indirection is what makes content sharing possible in Phase 3 without a data migration.

**2. One public surface for encrypting user data.**
`encryptRecord` and `decryptRecord` are the only functions the rest of the app calls to encrypt user data. Nothing outside the crypto module reaches into primitives directly.

**3. The storage layer is behind an interface.**
`localStorage` is used now. It will need to change. Every read and write of key material goes through `IKeyStorage`, not directly to `localStorage`. Swapping the implementation must require zero changes to any other module.

**4. Stubs ship with Phase 2.**
`PasskeyGuard`, `UserKeyPair`, and `ContentSharing` are created as stub modules that throw `NotImplementedError`. They define the final API contract so callers can import them today without breaking when Phase 3 lands.

**5. The server is zero-knowledge.**
The server receives ciphertext, IVs, wrapped content keys, the PBKDF2 salt (non-secret), and the key canary blob. It never receives the master key, a passphrase, or a raw content key.

---

## 2. Cryptographic Specification

All algorithms use the browser-native `SubtleCrypto` API. No polyfills, no libraries.

### Algorithms

| Purpose                   | Algorithm            | Parameters                                                         |
| ------------------------- | -------------------- | ------------------------------------------------------------------ |
| Data encryption           | AES-256-GCM          | 256-bit key, 96-bit IV, 128-bit auth tag                           |
| Content key wrapping      | AES-KW               | Master key wraps content key bytes                                 |
| Passphrase key derivation | PBKDF2-SHA-256       | 310,000 iterations, 256-bit output                                 |
| PBKDF2 salt               | Random               | 128 bits (16 bytes), `crypto.getRandomValues`                      |
| IV / Nonce                | Random               | 96 bits (12 bytes), `crypto.getRandomValues`, fresh per encryption |
| Recovery key encoding     | Hex                  | Raw key bytes → 64-char hex string                                 |
| Key pair (Phase 3)        | ECDH P-256 or X25519 | TBD at Phase 3 design time                                         |

### Master key properties

```
type:       AES-GCM
length:     256
extractable: true   ← required for localStorage persistence and future key transfer methods
usages:     ["encrypt", "decrypt", "wrapKey", "unwrapKey"]
```

> `extractable: true` is a deliberate trade-off for the POC. When the storage layer migrates to a platform keychain or a non-extractable `CryptoKey` backed by IndexedDB, this flag becomes `false` and the `wrapKey`/`unwrapKey` path changes to use the platform's secure storage API instead. The `IKeyStorage` interface abstracts this.

### Content key properties

```
type:       AES-GCM
length:     256
extractable: false   ← content keys never leave SubtleCrypto
usages:     ["encrypt", "decrypt"]
```

### Encrypted record wire format

This is what gets sent to the server and stored remotely. It is the canonical shape for all synced data.

```typescript
interface EncryptedRecord {
  version: 'v1'
  iv: string // base64-encoded 12-byte nonce used for AES-GCM
  ciphertext: string // base64-encoded encrypted payload + 16-byte auth tag
  wrappedContentKey: string // base64-encoded content key wrapped with master key (AES-KW)
  // Phase 3 addition — not present in v1:
  // recipientEnvelopes?: RecipientEnvelope[];
}
```

The server stores this as-is. It cannot decrypt it. The `version` field allows future schema evolution.

### Key canary format

Stored server-side per user account, not per device.

```typescript
interface KeyCanary {
  version: 'v1'
  iv: string // base64
  ciphertext: string // base64 — AES-GCM encryption of the fixed string "thunderbolt-key-check-v1"
}
```

### Recovery key display

The recovery key is displayed to the user as a 64-character hex string. The user copies it manually and stores it somewhere safe. There is no file download, no file import, and no JSON export in v1.

---

## 3. localStorage Schema

All keys are prefixed with `thunderbolt_`. Never log values from these keys.

| Key                              | Type   | Value                                           | Notes                                                                                                               |
| -------------------------------- | ------ | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `thunderbolt_enc_key`            | string | Base64-encoded raw 32-byte AES key              | Secret — the master key                                                                                             |
| `thunderbolt_enc_salt`           | string | Base64-encoded 16-byte PBKDF2 salt              | Non-secret — safe to also store server-side                                                                         |
| `thunderbolt_enc_version`        | string | `"v1"`                                          | For future migration detection                                                                                      |
| `thunderbolt_sync_enabled`       | string | `"true"` or `"false"`                           | Sync state flag                                                                                                     |
| `thunderbolt_key_state`          | string | `"NO_KEY"` \| `"KEY_PRESENT"` \| `"KEY_LOCKED"` | Cached state — must be kept in sync by masterKey module. See note below.                                            |
| `thunderbolt_passkey_registered` | string | `"true"` or `"false"`                           | Whether the user has completed passkey registration. Used on app startup to decide whether to show the lock screen. |

> **`thunderbolt_key_state` semantics:**
>
> - `NO_KEY` — no key material in storage. Sync is unavailable.
> - `KEY_PRESENT` — key is in storage and available for use in the current session. Sync can be enabled.
> - `KEY_LOCKED` — key exists in storage but is wrapped by a passkey credential. The raw key is NOT available. App must show the lock screen (Flow F) and call `unlockWithPasskey()` before any encryption/decryption can occur.
>
> `KEY_LOCKED` is NOT the same as `NO_KEY`. The key material exists — it just cannot be used until the user authenticates. `hasMasterKey()` must return `true` for both `KEY_PRESENT` and `KEY_LOCKED`.
>
> This key is not a source of truth — it is a fast synchronous read for startup checks. The master key manager is responsible for keeping it accurate.

---

## 4. Module Specifications

Each module below is a self-contained specification. Implement them in order within each phase — later modules depend on earlier ones.

---

### Phase 1 — Core Crypto & Storage

---

#### Module: `IKeyStorage` (interface + localStorage adapter)

**Purpose:** Isolate all key material I/O. Every read and write of encryption keys goes through this interface. Changing the storage backend (to IndexedDB, platform keychain, etc.) requires only a new implementation of this interface — zero changes elsewhere.

**Interface contract:**

```typescript
interface IKeyStorage {
  get(key: string): string | null
  set(key: string, value: string): void
  delete(key: string): void
  exists(key: string): boolean
  clear(): void // removes all thunderbolt_* keys — used on sign-out
}
```

**`LocalStorageAdapter` implementation rules:**

- Implements `IKeyStorage` backed by `window.localStorage`.
- `get` returns `null` if key is absent (do not throw).
- `set` must silently handle `QuotaExceededError` — catch, log a non-sensitive warning, rethrow a typed `StorageError`.
- `clear` must only remove keys that begin with `thunderbolt_` — it must not call `localStorage.clear()`.
- Export a singleton: `export const keyStorage: IKeyStorage = new LocalStorageAdapter()`.
- The singleton export is the only thing other modules import. They never instantiate the adapter directly. This is the seam that allows the singleton to be swapped in tests or in a future native build.

**Phase 3 note:** When passkey protection ships, a `PasskeyWrappedStorageAdapter` will implement `IKeyStorage` but store an encrypted blob instead of the raw key. No other module changes.

---

#### Module: Crypto Primitives

**Purpose:** Thin, stateless wrappers around `SubtleCrypto`. No business logic. Every function is independently unit-testable.

**Functions to implement:**

```typescript
// Generate a new random AES-256-GCM master key (extractable: true)
async function generateMasterKey(): Promise<CryptoKey>

// Generate a new random AES-256-GCM content key (extractable: false)
async function generateContentKey(): Promise<CryptoKey>

// Encrypt plaintext with a content key. Returns a fresh IV + ciphertext.
async function encrypt(key: CryptoKey, plaintext: Uint8Array): Promise<{ iv: Uint8Array; ciphertext: Uint8Array }>

// Decrypt ciphertext with a content key.
async function decrypt(key: CryptoKey, iv: Uint8Array, ciphertext: Uint8Array): Promise<Uint8Array>

// Wrap (encrypt) a content key using the master key via AES-KW.
// Returns raw wrapped key bytes.
async function wrapContentKey(masterKey: CryptoKey, contentKey: CryptoKey): Promise<Uint8Array>

// Unwrap (decrypt) a wrapped content key using the master key.
async function unwrapContentKey(masterKey: CryptoKey, wrappedKey: Uint8Array): Promise<CryptoKey>

// Export a CryptoKey to raw bytes (only valid for extractable keys).
async function exportKeyBytes(key: CryptoKey): Promise<Uint8Array>

// Import raw bytes as an AES-256-GCM CryptoKey.
// extractable parameter controls whether the resulting key can be exported again.
async function importKeyBytes(bytes: Uint8Array, extractable: boolean): Promise<CryptoKey>
```

**Implementation rules:**

- `encrypt` must call `crypto.getRandomValues(new Uint8Array(12))` for every invocation to generate a fresh IV. Never accept an IV as a parameter — callers must not reuse IVs.
- `decrypt` must propagate `DOMException` from SubtleCrypto unchanged. The caller (envelope module) decides how to handle auth tag failures.
- `wrapContentKey` uses `SubtleCrypto.wrapKey("raw", contentKey, masterKey, "AES-KW")`.
- `unwrapContentKey` uses `SubtleCrypto.unwrapKey` with `{ name: "AES-GCM", length: 256 }` as the unwrapped key algorithm, `extractable: false`, and `usages: ["encrypt", "decrypt"]`.
- No base64 encoding/decoding here — all inputs and outputs are raw `Uint8Array`. Encoding lives at the boundary modules (envelope, storage).

---

#### Module: Key Derivation

**Purpose:** PBKDF2 passphrase-to-key derivation and recovery key encoding/decoding.

**Functions to implement:**

```typescript
// Derive a master key from a passphrase and salt using PBKDF2-SHA-256.
async function deriveKeyFromPassphrase(passphrase: string, salt: Uint8Array): Promise<CryptoKey>

// Generate a cryptographically random 128-bit salt.
function generateSalt(): Uint8Array

// Encode raw key bytes as a 64-character lowercase hex string.
function encodeRecoveryKey(keyBytes: Uint8Array): string

// Decode a 64-char hex string back to raw bytes.
// Throws a typed ValidationError if the input is not exactly 64 hex characters.
function decodeRecoveryKey(hex: string): Uint8Array
```

**`deriveKeyFromPassphrase` implementation detail:**

```typescript
// 1. Encode passphrase to bytes
const passphraseBytes = new TextEncoder().encode(passphrase)

// 2. Import passphrase as a PBKDF2 key material
const baseKey = await crypto.subtle.importKey('raw', passphraseBytes, 'PBKDF2', false, ['deriveBits', 'deriveKey'])

// 3. Derive AES-256-GCM key
const derivedKey = await crypto.subtle.deriveKey(
  {
    name: 'PBKDF2',
    salt: salt,
    iterations: 310_000,
    hash: 'SHA-256',
  },
  baseKey,
  { name: 'AES-GCM', length: 256 },
  true, // extractable — must match master key contract
  ['encrypt', 'decrypt', 'wrapKey', 'unwrapKey'],
)
```

**`decodeRecoveryKey` validation:** Must check `hex.length === 64` and `/^[0-9a-f]+$/i.test(hex)` before attempting to parse. Throw a descriptive `ValidationError` on failure — this error surfaces directly to the UI.

---

#### Module: Master Key Manager

**Purpose:** Single source of truth for the master key. Owns persistence (via `IKeyStorage`), session caching, and key state management.

**Functions to implement:**

```typescript
// Load the master key from storage and import it into SubtleCrypto.
// Returns null if no key is stored.
// Caches the imported CryptoKey for the session — subsequent calls return the cached key.
async function getMasterKey(): Promise<CryptoKey | null>

// Persist a new master key. Accepts raw bytes.
// Clears the session cache before setting — forces re-import on next getMasterKey() call.
async function setMasterKey(keyBytes: Uint8Array): Promise<void>

// Remove the master key from storage and clear the session cache.
// Also clears salt and sets key state to NO_KEY.
async function clearMasterKey(): Promise<void>

// Synchronous check — reads thunderbolt_key_state from storage.
// Returns true for BOTH KEY_PRESENT and KEY_LOCKED — key material exists in both cases.
// Returns false only for NO_KEY.
function hasMasterKey(): boolean

// Returns the current key state as a typed enum.
// Synchronous — reads thunderbolt_key_state from localStorage cache.
function getKeyState(): KeyState

// Called on every app startup before rendering any UI.
// Returns the startup action the app must take:
// - "READY"            → key is present and usable. App loads normally.
// - "NO_KEY"           → no key set up. App loads normally, sync unavailable.
// - "REQUIRES_UNLOCK"  → KEY_LOCKED state (Phase 3). App must show lock screen (Flow F)
//                        and call unlockWithPasskey() before any decryption is allowed.
function getStartupAction(): 'READY' | 'NO_KEY' | 'REQUIRES_UNLOCK'

// KeyState enum
enum KeyState {
  NO_KEY = 'NO_KEY',
  KEY_PRESENT = 'KEY_PRESENT',
  KEY_LOCKED = 'KEY_LOCKED', // Phase 3: key exists but is wrapped by passkey — unwrap required on startup
}
```

**Session cache implementation:**
Use a module-scoped variable, not a `WeakRef`:

```typescript
let _cachedKey: CryptoKey | null = null
```

`clearMasterKey` sets `_cachedKey = null`. `setMasterKey` also sets `_cachedKey = null` (it will be re-imported lazily on the next `getMasterKey` call rather than imported eagerly — this avoids an async side-effect in what should be a simple setter).

**`setMasterKey` side effects (in order):**

1. Base64-encode `keyBytes` and write to `thunderbolt_enc_key` via `keyStorage`.
2. Write `"v1"` to `thunderbolt_enc_version`.
3. Write `"KEY_PRESENT"` to `thunderbolt_key_state`.
4. Set `_cachedKey = null`.

**`clearMasterKey` side effects (in order):**

1. Call `keyStorage.clear()` — removes all `thunderbolt_*` keys.
2. Set `_cachedKey = null`.

---

#### Module: Key Canary

**Purpose:** Create and verify a server-stored proof that a given key is the correct one. Used in all import flows to reject wrong keys before enabling sync.

**Fixed plaintext constant:**

```typescript
const CANARY_PLAINTEXT = 'thunderbolt-key-check-v1'
```

**Functions to implement:**

```typescript
// Encrypt CANARY_PLAINTEXT with the given master key.
// Returns a serialisable canary blob for upload to the server.
async function createCanary(masterKey: CryptoKey): Promise<KeyCanary>

// Decrypt the canary blob with the given master key and check the plaintext.
// Returns true if decryption succeeds and plaintext matches CANARY_PLAINTEXT.
// Returns false (does NOT throw) if decryption fails — wrong key.
async function verifyCanary(masterKey: CryptoKey, canary: KeyCanary): Promise<boolean>
```

**`createCanary` implementation notes:**

- Encrypts using the master key directly (not through envelope encryption) — the canary is not user data.
- The IV is embedded in the returned `KeyCanary` object as base64.
- The `KeyCanary` object should be JSON-serialisable to be stored on the server.

**`verifyCanary` implementation notes:**

- Must catch `DOMException` from SubtleCrypto — a failed GCM auth tag throws rather than returns. Return `false` in the catch block.
- After successful decryption, compare the decoded plaintext to `CANARY_PLAINTEXT` with a constant-time comparison (use `crypto.subtle.timingSafeEqual` if available, otherwise compare byte-by-byte in a loop that does not short-circuit).

---

#### Module: Envelope Encryption

**Purpose:** The only public API for encrypting and decrypting user data. Composes primitives + master key manager into a single call. This is the most important module — it enforces the envelope pattern that makes Phase 3 possible.

**Functions to implement:**

```typescript
// Encrypt a plaintext payload. Fetches the master key internally.
// Generates a fresh content key and IV for every call.
// Returns a fully serialisable EncryptedRecord.
async function encryptRecord(plaintext: string): Promise<EncryptedRecord>

// Decrypt an EncryptedRecord. Fetches the master key internally.
// Returns the original plaintext string.
// Throws EncryptionError if master key is unavailable.
// Throws DecryptionError if auth tag verification fails.
async function decryptRecord(record: EncryptedRecord): Promise<string>
```

**`encryptRecord` implementation (step by step):**

1. Call `getMasterKey()`. If null, throw `EncryptionError("No master key available")`.
2. Call `generateContentKey()` to get a fresh, non-extractable AES-256-GCM key.
3. Encode `plaintext` to bytes: `new TextEncoder().encode(plaintext)`.
4. Call `encrypt(contentKey, plaintextBytes)` → `{ iv, ciphertext }`.
5. Call `wrapContentKey(masterKey, contentKey)` → `wrappedContentKeyBytes`.
6. Return:

```typescript
{
  version: "v1",
  iv: toBase64(iv),
  ciphertext: toBase64(ciphertext),
  wrappedContentKey: toBase64(wrappedContentKeyBytes),
}
```

**`decryptRecord` implementation (step by step):**

1. Call `getMasterKey()`. If null, throw `EncryptionError("No master key available")`.
2. Decode `record.wrappedContentKey` from base64 → `wrappedKeyBytes`.
3. Call `unwrapContentKey(masterKey, wrappedKeyBytes)` → `contentKey`.
4. Decode `record.iv` from base64 → `iv`.
5. Decode `record.ciphertext` from base64 → `ciphertext`.
6. Call `decrypt(contentKey, iv, ciphertext)` → `plaintextBytes`.
7. Return `new TextDecoder().decode(plaintextBytes)`.

**Error types to define and export:**

```typescript
class EncryptionError extends Error {
  constructor(message: string)
}
class DecryptionError extends Error {
  constructor(message: string)
}
```

`DecryptionError` is thrown when `decrypt` throws a `DOMException` (auth tag failure). This is the signal that the ciphertext has been tampered with or the wrong key was used.

---

### Phase 2 — Sync Setup Flows

---

#### Module: Key Setup Service

**Purpose:** Orchestrates all key creation and import flows. This is the bridge between the UI and the crypto layer. All Sync Setup modal actions call into this module.

**Functions to implement:**

```typescript
type KeySetupResult =
  | { success: true }
  | { success: false; error: 'WRONG_KEY' | 'INVALID_FORMAT' | 'SERVER_ERROR' | 'NETWORK_ERROR' }

// Sub-flow C1: Create a brand-new master key.
// If passphrase is provided, derives key via PBKDF2 and stores the salt.
// If passphrase is omitted, generates a random key.
// Always: creates canary, uploads canary + salt to server, stores key locally.
// Returns the recovery key hex string for display — the UI shows it as a copyable string.
// The UI is responsible for showing the passkey prompt AFTER this resolves successfully
// (see Passkey Setup flow — this function does not call registerPasskey).
async function createNewKey(passphrase?: string): Promise<{ result: KeySetupResult; recoveryKey: string }>

// Sub-flow C2: Import a key by re-deriving from passphrase.
// Fetches the salt from the server, derives the key, verifies canary, stores key.
// On success, the UI must offer the passkey setup prompt (see Passkey Setup flow).
// This function does NOT call registerPasskey — passkey setup is always a post-import UI step.
async function importFromPassphrase(passphrase: string): Promise<KeySetupResult>

// Recovery key entry: Import a key from a 64-char hex recovery key.
// Decodes hex, imports key, verifies canary against server, stores key.
// On success, the UI must offer the passkey setup prompt (see Passkey Setup flow).
async function importFromRecoveryKey(hexKey: string): Promise<KeySetupResult>
```

**`createNewKey` implementation (step by step):**

1. If `passphrase` provided:
   - Call `generateSalt()` → `salt`.
   - Call `deriveKeyFromPassphrase(passphrase, salt)` → `masterKey`.
   - Store salt: `keyStorage.set("thunderbolt_enc_salt", toBase64(salt))`.
2. If no `passphrase`:
   - Call `generateMasterKey()` → `masterKey`.
   - `salt` = empty/null — no passphrase path, recovery key is the only recovery method.
3. Call `exportKeyBytes(masterKey)` → `keyBytes`.
4. Call `setMasterKey(keyBytes)`.
5. Call `createCanary(masterKey)` → `canary`.
6. Upload `{ canary, salt: toBase64(salt) }` to the server (see Server API contract below).
7. Call `encodeRecoveryKey(keyBytes)` → `recoveryKeyHex`.
8. Return `{ result: { success: true }, recoveryKey: recoveryKeyHex }`.

**`importFromPassphrase` implementation:**

1. Fetch `{ salt, canary }` from server for the current user account (see Server API contract).
2. Call `deriveKeyFromPassphrase(passphrase, fromBase64(salt))` → `masterKey`.
3. Call `verifyCanary(masterKey, canary)`. If `false`, return `{ success: false, error: "WRONG_KEY" }`.
4. Call `exportKeyBytes(masterKey)` → `keyBytes`.
5. Call `setMasterKey(keyBytes)`.
6. Store salt: `keyStorage.set("thunderbolt_enc_salt", salt)`.
7. Return `{ success: true }`.

````

**`importFromRecoveryKey` implementation:**

1. Call `decodeRecoveryKey(hexKey)`. Catch `ValidationError` → return `{ success: false, error: "INVALID_FORMAT" }`.
2. Call `importKeyBytes(keyBytes, true)` → `masterKey`.
3. Fetch `{ canary }` from server for current user.
4. Call `verifyCanary(masterKey, canary)`. If `false`, return `{ success: false, error: "WRONG_KEY" }`.
5. Call `setMasterKey(keyBytes)`.
6. Return `{ success: true }`.

---

#### Module: Recovery Key UI Helper

**Purpose:** Formats the recovery key for display as a copyable string. This is a UI-boundary module — the only place that touches string presentation in the crypto stack. There is no file download or export in v1.

**Functions to implement:**

```typescript
// Format the recovery key hex string for display — groups of 8 chars separated by spaces
// for readability: "a1b2c3d4 e5f6a7b8 ..."
// The UI renders this in a monospace copyable field. The user copies it manually.
function formatRecoveryKeyForDisplay(hex: string): string
````

---

#### Module: Sync Gate

**Purpose:** Single integration point between the Settings UI and the encryption + sync system. The UI toggle calls `enableSync()` / `disableSync()` and reacts to `SyncState`. It knows nothing about keys.

**Important:** `KEY_LOCKED` is handled at **app startup** (Flow F), not here. By the time the user can reach the Settings toggle, the key is either `NO_KEY`, `KEY_PRESENT`, or the app is showing a lock screen. `enableSync` never sees `KEY_LOCKED`.

**Functions to implement:**

```typescript
// Returns the current sync state. Synchronous — reads from in-memory state + keyStorage.
function getSyncState(): SyncState

// Attempt to enable sync.
// If KEY_PRESENT: enables sync immediately, triggers migration job, returns ENABLED.
// If NO_KEY: does NOT enable sync — returns REQUIRES_KEY_SETUP.
//   The UI must open the Sync Setup modal in response to REQUIRES_KEY_SETUP.
//   After the modal completes successfully, the UI calls enableSync() again.
async function enableSync(): Promise<EnableSyncResult>

// Disable sync. Does NOT delete the key. Persists the disabled state.
function disableSync(): void

// Register a callback to be invoked when sync transitions to ENABLED.
// Used by the sync engine to kick off the migration job.
function onSyncEnabled(callback: () => void): void

// SyncState enum
enum SyncState {
  DISABLED = 'DISABLED',
  ENABLED = 'ENABLED',
}

// EnableSyncResult
type EnableSyncResult = { status: 'ENABLED' } | { status: 'REQUIRES_KEY_SETUP' }
// Note: REQUIRES_UNLOCK is intentionally absent.
// KEY_LOCKED is resolved at app startup (Flow F) before any UI is reachable.
```

**`enableSync` implementation:**

```typescript
async function enableSync(): Promise<EnableSyncResult> {
  const keyState = getKeyState() // from masterKey module
  if (keyState === KeyState.NO_KEY) {
    return { status: 'REQUIRES_KEY_SETUP' }
  }
  // KEY_LOCKED cannot reach this point — app startup resolves it via Flow F first.
  // KEY_PRESENT falls through to enable sync.
  keyStorage.set('thunderbolt_sync_enabled', 'true')
  _syncEnabled = true
  _onSyncEnabledCallbacks.forEach((cb) => cb())
  return { status: 'ENABLED' }
}
```

**UI integration pattern — Settings sync toggle:**

```typescript
async function handleSyncToggle(checked: boolean) {
  if (!checked) {
    disableSync()
    return
  }
  const result = await enableSync()
  if (result.status === 'REQUIRES_KEY_SETUP') {
    // Open Sync Setup modal.
    // Modal calls createNewKey() / importFrom*() on completion.
    // On modal success, the modal itself calls enableSync() again.
    openSyncSetupModal()
  }
}
```

**UI integration pattern — Sync Setup modal completion (sub-flows C1 and C2):**

After any successful key creation or import, the modal must:

1. Show the recovery key as a copyable formatted string — user must confirm they have copied it before proceeding (C1 only — creation path). No download button.
2. Offer the passkey setup prompt — call `registerPasskey()` stub if user opts in (all sub-flows).
3. Call `enableSync()` — at this point key state is `KEY_PRESENT`, so it returns `ENABLED` immediately.
4. Close the modal.

```typescript
// Called inside the modal after createNewKey() / importFrom*() returns { success: true }
async function onKeySetupSuccess(recoveryKey?: string) {
  if (recoveryKey) {
    // Show formatted recovery key in a monospace copyable field.
    // User must check "I have copied my recovery key" before the Continue button is enabled.
    const formatted = formatRecoveryKeyForDisplay(recoveryKey)
    await showRecoveryKeyCopyStep(formatted)
  }
  // Offer passkey setup — user may skip
  const wantsPasskey = await promptPasskeySetup()
  if (wantsPasskey) {
    await registerPasskey() // Phase 3 stub — throws NotImplementedError for now
  }
  // Enable sync — key is now KEY_PRESENT
  await enableSync()
}
```

---

#### Module: Local Data Migration

**Purpose:** When sync is enabled for the first time (or re-enabled after a gap), all local records that have not been synced must be encrypted and uploaded. This runs as a resumable background job.

**Functions to implement:**

```typescript
interface MigrationStatus {
  total: number
  completed: number
  failed: number
  status: 'idle' | 'running' | 'done' | 'error'
}

// Start the migration job. Safe to call multiple times — idempotent if already running.
// Processes records in batches of BATCH_SIZE (default: 20).
// Emits progress events via the onProgress callback.
async function migrateLocalData(onProgress?: (status: MigrationStatus) => void): Promise<MigrationStatus>
```

**Implementation rules:**

- Query the local DB for all records where `sync_status = "local_only"` or `sync_status = null`.
- For each record:
  1. Serialize the record payload to a JSON string.
  2. Call `encryptRecord(json)` → `EncryptedRecord`.
  3. Upload the `EncryptedRecord` to the server via the sync API.
  4. On successful upload, update the local record's `sync_status` to `"synced"`.
  5. On upload failure, increment `failed` counter and continue — do not abort the entire job.
- The local plaintext record is never modified or deleted — it is the local working copy.
- Process in batches to avoid blocking the main thread for large local datasets. Use `await new Promise(r => setTimeout(r, 0))` between batches to yield.
- The job is registered as the `onSyncEnabled` callback in the sync gate.

---

### Phase 3 — Stubs (implement signatures only, throw `NotImplementedError`)

These modules must exist and export the correct types. They must not be implemented. Their purpose is to give the rest of the codebase stable import paths today.

---

#### Stub: User Key Pair

```typescript
// Generates an ECDH P-256 or X25519 key pair for the user account.
// Public key is uploaded to the server. Private key is stored locally.
async function generateUserKeyPair(): Promise<never> {
  throw new NotImplementedError('generateUserKeyPair is Phase 3')
}

async function getUserPublicKey(): Promise<never> {
  throw new NotImplementedError('getUserPublicKey is Phase 3')
}

async function getUserPrivateKey(): Promise<never> {
  throw new NotImplementedError('getUserPrivateKey is Phase 3')
}
```

---

#### Stub: Content Sharing

```typescript
// Wraps a content key for one or more recipients using their public keys.
// Each recipient can unwrap the content key with their own private key.
async function encryptForRecipients(contentKey: CryptoKey, recipientPublicKeys: CryptoKey[]): Promise<never> {
  throw new NotImplementedError('encryptForRecipients is Phase 3')
}

// Unwrap a recipient envelope using the current user's private key.
async function decryptFromSender(envelope: RecipientEnvelope, privateKey: CryptoKey): Promise<never> {
  throw new NotImplementedError('decryptFromSender is Phase 3')
}

// Type definitions — NOT stubs, these are real and used today for type-checking
interface RecipientEnvelope {
  recipientUserId: string
  wrappedContentKey: string // base64 — content key wrapped with recipient's public key
}

// This is the Phase 3 extension of EncryptedRecord.
// The base EncryptedRecord type must NOT include this field.
// This interface extends it so Phase 3 code can use it without modifying the core type.
interface SharedEncryptedRecord extends EncryptedRecord {
  recipientEnvelopes: RecipientEnvelope[]
}
```

---

#### Stub: Passkey Guard

This module handles the full passkey lifecycle described in Flow F and Passkey Setup. All functions are stubs in Phase 1 and 2. The function signatures and types are real — only the bodies throw.

**Flow F contract (app startup):**
When `getStartupAction()` returns `"REQUIRES_UNLOCK"`, the app renders a lock screen and calls `unlockWithPasskey()`. On success the session cache in the master key manager is populated and the app proceeds normally. The raw key is never re-written to localStorage in unwrapped form during the session.

**Passkey Setup contract (post key creation/import):**
After any successful key setup flow (C1, C2, C3), the UI optionally calls `registerPasskey()`. On success the master key is wrapped by the passkey credential and re-stored. Key state transitions to `KEY_LOCKED` on session end (app close / sign-out). On the next launch, `getStartupAction()` returns `"REQUIRES_UNLOCK"`.

```typescript
// Called after key creation or import when the user opts into passkey protection.
// Runs the WebAuthn registration ceremony.
// On success: wraps the current master key with the passkey credential,
// updates stored key to the wrapped form, sets thunderbolt_passkey_registered = "true".
// Key state remains KEY_PRESENT for the current session.
// On next app startup (after session end), state will be KEY_LOCKED.
async function registerPasskey(): Promise<never> {
  throw new NotImplementedError('registerPasskey is Phase 3')
}

// Called on app startup when getStartupAction() returns "REQUIRES_UNLOCK".
// Runs the WebAuthn authentication ceremony.
// On success: unwraps the master key into the masterKey module's session cache.
//   Key state transitions to KEY_PRESENT for this session.
//   The unwrapped key is NEVER written back to localStorage.
// On failure / user cancel: throws PasskeyAuthError — app stays on lock screen.
async function unlockWithPasskey(): Promise<never> {
  throw new NotImplementedError('unlockWithPasskey is Phase 3')
}

// Called on session end (sign-out, app close) when passkey is registered.
// Clears the session cache in the master key manager.
// Does NOT delete the wrapped key from storage — it stays for the next startup unlock.
// Sets thunderbolt_key_state = "KEY_LOCKED".
function lockSession(): void {
  throw new NotImplementedError('lockSession is Phase 3')
}
```

**App startup integration pattern (pseudocode — to be implemented in Phase 3):**

```typescript
async function initApp() {
  const action = getStartupAction()
  if (action === 'REQUIRES_UNLOCK') {
    showLockScreen()
    try {
      await unlockWithPasskey() // populates session cache
      hideLockScreen()
      loadApp()
    } catch (e) {
      // Stay on lock screen — do not load app
    }
  } else {
    // "READY" or "NO_KEY" — load app normally
    loadApp()
  }
}
```

---

## 5. Server API Contract

These are the server endpoints the encryption module calls. Define the request/response shapes here so the server team can implement them in parallel.

```typescript
// POST /api/encryption/setup
// Called once at key creation time.
// Stores the canary and salt for the user account.
// The server cannot decrypt the canary — it stores it opaquely.
interface SetupRequest {
  canary: KeyCanary
  salt: string // base64-encoded PBKDF2 salt — may be empty string if key was randomly generated
}
interface SetupResponse {
  success: boolean
}

// GET /api/encryption/setup
// Called on import flows (passphrase, recovery key) to retrieve the canary and salt.
// Requires authentication.
interface SetupGetResponse {
  canary: KeyCanary
  salt: string
}

// PUT /api/sync/record
// Upload a single encrypted record.
interface SyncRecordRequest {
  recordId: string
  recordType: string // "conversation" | "message" | "preference" | etc.
  encryptedRecord: EncryptedRecord
}
interface SyncRecordResponse {
  success: boolean
}

// GET /api/sync/records
// Fetch all encrypted records for the user. Called on new device setup.
interface SyncRecordsResponse {
  records: Array<{
    recordId: string
    recordType: string
    encryptedRecord: EncryptedRecord
  }>
}
```

---

## 6. Error Types

Define these in a shared errors module. All other modules import from it.

```typescript
class NotImplementedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'NotImplementedError'
  }
}

class EncryptionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'EncryptionError'
  }
}

class DecryptionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DecryptionError'
  }
}

class ValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ValidationError'
  }
}

class StorageError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'StorageError'
  }
}
```

---

## 7. Utility Functions

These are small helpers used across modules. Define them once in a shared utilities module.

```typescript
// Base64 encode a Uint8Array
function toBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
}

// Base64 decode a string to Uint8Array
function fromBase64(b64: string): Uint8Array {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
}

// Encode a hex string to Uint8Array
function fromHex(hex: string): Uint8Array {
  const result = new Uint8Array(hex.length / 2)
  for (let i = 0; i < hex.length; i += 2) {
    result[i / 2] = parseInt(hex.slice(i, i + 2), 16)
  }
  return result
}

// Encode a Uint8Array to lowercase hex string
function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

// Constant-time byte array comparison (prevents timing attacks on canary verification)
function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) {
    diff |= a[i] ^ b[i]
  }
  return diff === 0
}
```

---

## 8. Implementation Order

Follow this order strictly. Each item depends on the ones above it.

**Phase 1:**

1. Error types (shared errors module)
2. Utility functions (shared utilities module)
3. `IKeyStorage` interface + `LocalStorageAdapter`
4. Crypto primitives
5. Key derivation
6. Master key manager
7. Key canary
8. Envelope encryption ← milestone: write integration tests here before moving to Phase 2

**Phase 2:** 9. Recovery key UI helper 10. Key setup service 11. Sync gate 12. Local data migration

**Phase 3 stubs (add alongside Phase 2, before Phase 2 ships):** 13. `NotImplementedError` (already defined in error types — just confirm it's exported) 14. User key pair stub 15. Content sharing stub (export `RecipientEnvelope` and `SharedEncryptedRecord` types as real types — only the functions are stubs) 16. Passkey guard stub

---

## 9. Testing Checklist

These are the critical cases that must be covered before shipping. Not a complete test suite — a minimum bar.

**Crypto primitives:**

- `encrypt` + `decrypt` round-trip returns the original plaintext.
- `encrypt` called twice with the same key produces different IVs and different ciphertexts.
- `decrypt` with a tampered ciphertext throws `DOMException`.
- `wrapContentKey` + `unwrapContentKey` round-trip returns a functionally equivalent key.

**Key derivation:**

- `deriveKeyFromPassphrase` with the same passphrase and salt produces the same key bytes.
- `deriveKeyFromPassphrase` with a different salt produces a different key.
- `decodeRecoveryKey` throws `ValidationError` for strings that are not 64 hex chars.

**Envelope encryption:**

- `encryptRecord` + `decryptRecord` round-trip returns the original string.
- `decryptRecord` with a tampered `ciphertext` field throws `DecryptionError`.
- `decryptRecord` with a tampered `wrappedContentKey` field throws `DecryptionError`.
- `encryptRecord` called twice with the same plaintext produces different `iv` and `ciphertext` values.

**Key canary:**

- `createCanary` + `verifyCanary` with the same key returns `true`.
- `verifyCanary` with a different key returns `false` (does not throw).

**Key setup service:**

- `createNewKey` with a passphrase: derived key can be recovered via `importFromPassphrase` with the same passphrase.
- `createNewKey` without a passphrase: returned `recoveryKey` hex successfully imports via `importFromRecoveryKey`.
- `importFromPassphrase` with the wrong passphrase returns `{ success: false, error: "WRONG_KEY" }`.
- `importFromRecoveryKey` with a malformed hex string returns `{ success: false, error: "INVALID_FORMAT" }`.
- All import functions (`importFromPassphrase`, `importFromRecoveryKey`) do NOT call `registerPasskey` — that is always a post-import UI step.

**Master key manager — startup action:**

- `getStartupAction()` returns `"NO_KEY"` when `thunderbolt_key_state` is absent or `"NO_KEY"`.
- `getStartupAction()` returns `"READY"` when `thunderbolt_key_state` is `"KEY_PRESENT"`.
- `getStartupAction()` returns `"REQUIRES_UNLOCK"` when `thunderbolt_key_state` is `"KEY_LOCKED"` (Phase 3 state — simulate by writing directly to storage in the test).
- `hasMasterKey()` returns `true` for both `KEY_PRESENT` and `KEY_LOCKED`.
- `hasMasterKey()` returns `false` for `NO_KEY`.

**Sync gate:**

- `enableSync` with `NO_KEY` returns `REQUIRES_KEY_SETUP` and does not enable sync.
- `enableSync` with `KEY_PRESENT` returns `ENABLED` and fires `onSyncEnabled` callbacks.
- `enableSync` never returns `REQUIRES_UNLOCK` — `KEY_LOCKED` is always resolved before the user reaches any UI that can trigger sync.
- `disableSync` sets sync state to `DISABLED` without clearing the key.

---

## 10. Constraints and Non-Goals for This Implementation

**Hard constraints:**

- The master key must never appear in any log output, error message, or network request body other than the `POST /api/encryption/setup` upload (which the server treats as opaque).
- `encryptRecord` / `decryptRecord` are the only functions permitted to encrypt user data. No other module calls `encrypt` / `decrypt` from primitives on user data.
- The `IKeyStorage` interface must be the only path for persisting key material. Direct calls to `localStorage.setItem` / `localStorage.getItem` for key data anywhere outside `LocalStorageAdapter` are a bug.

**Non-goals for Phases 1 and 2:**

- QR code key transfer (deferred to a future sprint).
- Recovery key file download or import (deferred — v1 is copy-paste only).
- Key rotation (re-encrypting all synced data with a new master key).
- Encrypting local-only data (data that has never been synced).
- Binary / file attachment encryption.
- Passkey protection (stubs only).
- Content sharing between users (stubs only).
- Enterprise admin key recovery.
- Any UI components — this blueprint covers the logic layer only.
