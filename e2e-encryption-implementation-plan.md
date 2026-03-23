# E2E Encryption Implementation Plan

## Context

Thunderbolt is moving from a passphrase-based encryption model (PR #465) to a per-device key + device approval model. The new approach eliminates the passphrase credential, uses per-device RSA key pairs to wrap a shared Content Key (CK), and introduces device approval and recovery key flows. PRs #454 and #480 are discarded. PR #465 has useful crypto primitives (AES-GCM, canary, recovery key format) but the architecture is fundamentally different.

**Current main branch state:**
- `devices` table exists and syncs via PowerSync (fields: id, userId, name, lastSeen, createdAt, revokedAt)
- Device revocation works via `revokedAt` timestamp
- Sync toggle in Settings exists (calls `setSyncEnabled()`)
- No encryption code on main

**What changes:**
- Devices keep `revokedAt` but also get `status` (APPROVAL_PENDING | TRUSTED | REVOKED)
- Devices get `public_key` field (set when user enables sync)
- Two new server-only tables: `envelopes`, `encryption_metadata`
- 5 new API endpoints for device registration, envelope management, canary
- Full FE crypto module (key pairs, CK, wrap/unwrap, canary, recovery key)
- Redesigned sync setup UI (no passphrase, device approval flow instead)

**Key decisions:**
- RSA-OAEP 2048-bit for device key pairs
- Keep `revokedAt` alongside `status`
- 5 PRs total, UI-first approach

---

## PR 1: FE — UI Components (fully mocked, zero dependencies)

**Goal:** Build all encryption-related UI screens with mock data. No schema changes, no crypto imports, no API calls. Pure UI — enables UX review before any backend or crypto work begins.

### Approach
- All device status values (APPROVAL_PENDING, TRUSTED, REVOKED) are local string literals or a local type definition within this PR — no DB schema changes
- All callbacks are stubs (e.g. `onApprove`, `onSubmitRecoveryKey`) that log or no-op
- Recovery key display uses a hardcoded mock hex string
- Device list uses mock data arrays, not real DB queries for new fields
- **Sync actually enables** after wizard completion — `setSyncEnabled(true)` runs for real. Sync works as before (unencrypted). Encryption gets wired in PR 5.
- **Temporary test-only first step** in the wizard: a "Choose flow" screen that lets the tester pick between "First device" and "Additional device" paths. This step is removed in PR 5 when real server detection (`firstDevice: true/false`) replaces it.

### New components

**`src/components/sync-setup/sync-setup-modal.tsx`** — Redesigned wizard
- First step (test-only): "Choose flow" picker — First device vs Additional device (removed in PR 5)
- First device path: show-recovery-key → done (calls `setSyncEnabled(true)`)
- Additional device path: approval-waiting → (continue or use-recovery-key-entry) → done
- No passphrase step

**`src/components/sync-setup/recovery-key-step.tsx`** — Show recovery key
- Display 64-char hex in formatted groups (8-char chunks)
- Copy to clipboard button
- "Done" button (dismisses, sync already active)

**`src/components/sync-setup/approval-waiting-step.tsx`** — Waiting for approval
- Instructions to open trusted device
- "Use recovery key instead" link → navigates to recovery key entry
- Checkbox "I have approved this device on another device" + Continue button (disabled until checked)

**`src/components/sync-setup/recovery-key-entry-step.tsx`** — Enter recovery key
- 64-char hex input with validation (length, hex chars only)
- Error state for incorrect key
- Submit button

**`src/settings/devices.tsx`** — Add "Pending Approvals" section
- New **first section** at top of page: "Pending Approvals" with mocked pending device data
- Each pending device shows name + "Approve" button (stub callback in PR 1, wired in PR 5)
- Section is hidden when no pending devices exist (in PR 1: always visible with mock data for review)
- Existing device list section below remains untouched (still uses real DB + `revokedAt`)
- This section layout is **permanent** — kept in PR 5, just wired to real synced data instead of mocks

### Hooks (with stubs)
- `src/hooks/use-sync-setup.ts` — State machine for the new setup flow
  - States: idle → generating → show-recovery-key | approval-waiting → recovery-key-entry → success
  - All crypto/API calls are stubs returning mock data

### Reusable from #465
- Modal shell and step transition pattern from `sync-setup-modal.tsx`
- Recovery key display formatting from `create-show-key-step.tsx`
- General component structure patterns

### Verification
- Visual review of all UI states
- Test all step transitions in the wizard
- Verify responsive sizing with mobile/desktop breakpoints
- `bun run typecheck` passes — no new schema or external dependencies

---

## PR 2: Backend — Schema & Migrations

**Goal:** Add all database tables and columns needed for encryption. No API changes yet.

### Changes

**Modify `devices` table** (`backend/src/db/powersync-schema.ts`):
- Add `status` column: `text('status').notNull().default('TRUSTED')`
- Add `publicKey` column: `text('public_key')`
- Keep `revokedAt` alongside `status` (preserves revocation timestamp for UI "show revoked last 24h" filter)
- Migration sets `status='REVOKED'` where `revokedAt IS NOT NULL`

**Create `envelopes` table** (new table in backend schema, not synced via PowerSync):
- `deviceId` (text, PK, FK → devices)
- `userId` (text, FK → users)
- `wrappedCk` (text, base64)
- `createdAt`, `updatedAt` (timestamps)

**Create `encryption_metadata` table** (server-only, not synced):
- `userId` (text, PK, FK → users)
- `canaryIv` (text, base64)
- `canaryCtext` (text, base64)
- `createdAt` (timestamp)

**Drizzle migration:**
- `bun db generate` for the migration SQL
- Verify `backend/drizzle/meta/_journal.json` includes new entry

**Note:** `config.yaml` uses `SELECT * FROM powersync.devices` — new columns auto-sync. No config change needed.

### Files to modify
- `backend/src/db/powersync-schema.ts` — add columns + new tables
- `backend/drizzle/` — new migration file + journal entry
- `backend/drizzle/meta/` — new snapshot

### Verification
- Run `bun db generate` successfully
- Verify migration SQL is correct (columns, types, defaults, FK constraints)
- Check journal entry exists in `_journal.json`

---

## PR 3: Backend — API Endpoints & Device Logic Update

**Goal:** Implement all 5 encryption API endpoints. Update existing device logic to use `status` field.

### New endpoints

**`POST /devices`** — Register or identify a device
- Input: `{ deviceId, publicKey }`
- Logic: If device exists + TRUSTED → return envelope. If exists + PENDING → return status. If new + envelopes exist for user → create APPROVAL_PENDING. If new + no envelopes → return `firstDevice: true`.
- Auth: session required

**`POST /devices/:deviceId/envelope`** — Store envelope + mark trusted
- Input: `{ wrappedCK, canary_iv?, canary_ctext? }` (canary fields only on first device)
- Logic: Store envelope row. If first device, store canary in `encryption_metadata` (idempotent — skip if row exists). Set device status to TRUSTED.
- Auth: session required. Callable by device itself (first device) or by a trusted device (approval).

**`GET /devices/me/envelope`** — Fetch own envelope
- Returns calling device's envelope only (enforced by device ID from X-Device-ID header)
- Auth: session + X-Device-ID

**`GET /encryption/canary`** — Fetch canary for recovery key verification
- Returns `{ canaryIv, canaryCtext }` for current user
- Auth: session required

**Update `POST /account/devices/:id/revoke`:**
- Also delete envelope from `envelopes` table
- Set `status = 'REVOKED'` (in addition to existing `revokedAt`)

### Update existing device logic
- `backend/src/api/powersync.ts` — check `status !== 'REVOKED'` instead of (or in addition to) `revokedAt`
- `backend/src/dal/devices.ts` — update `revokeDevice` to also set status, add new DAL functions for envelopes and encryption_metadata

### Files to create/modify
- `backend/src/api/encryption.ts` — new route file
- `backend/src/dal/encryption.ts` — new DAL (envelopes + encryption_metadata)
- `backend/src/dal/devices.ts` — update revokeDevice, add findDevicesByUser
- `backend/src/api/powersync.ts` — use status field
- `backend/src/api/account.ts` — update revoke to delete envelope
- `backend/src/index.ts` — register new routes

### Reusable from #465
- `backend/src/dal/encryption.ts` pattern (adapt for new table schema)
- `backend/src/api/encryption.ts` route structure (adapt for new endpoints)

### Verification
- Test each endpoint with curl/httpie
- Verify device state transitions (APPROVAL_PENDING → TRUSTED → REVOKED)
- Test revocation deletes envelope
- Test first-device detection logic

---

## PR 4: FE — Crypto Module (pure functions + storage)

**Goal:** Implement all cryptographic operations and key storage. Pure functions with no UI or API dependencies. Fully unit-testable.

### Modules

**`src/crypto/primitives.ts`** — Low-level Web Crypto wrappers
- `generateKeyPair()` → RSA-OAEP 2048-bit key pair for wrap/unwrap
- `generateCK()` → AES-256-GCM key (extractable: true for initial setup, then re-import)
- `wrapCK(ck, publicKey)` → base64 wrapped CK
- `unwrapCK(wrappedCK, privateKey)` → CryptoKey
- `encrypt(plaintext, ck)` → `{ iv, ciphertext }` (AES-256-GCM, 12-byte IV)
- `decrypt({ iv, ciphertext }, ck)` → plaintext
- `exportPublicKey(key)` → base64 (for sending to server)
- `importPublicKey(base64)` → CryptoKey (for wrapping CK with another device's public key)
- `reimportAsNonExtractable(ck)` → non-extractable CryptoKey

**`src/crypto/canary.ts`** — Canary creation and verification
- `createCanary(ck)` → `{ canaryIv, canaryCtext }` (encrypts "thunderbolt-canary-v1")
- `verifyCanary(ck, canaryIv, canaryCtext)` → boolean

**`src/crypto/recovery-key.ts`** — Recovery key encode/decode
- `encodeRecoveryKey(ck)` → 64-char hex string (requires extractable CK)
- `decodeRecoveryKey(hex)` → CryptoKey (AES-256-GCM, non-extractable)

**`src/crypto/key-storage.ts`** — IndexedDB + localStorage
- `storeKeyPair(privateKey, publicKey)` → IndexedDB
- `getKeyPair()` → `{ privateKey, publicKey } | null`
- `storeCK(ck)` → IndexedDB
- `getCK()` → CryptoKey | null
- `clearCK()` — for sign-out
- `clearAllKeys()` — for full wipe
- `getDeviceId()` / `setDeviceId()` → localStorage
- `getSyncEnabled()` / `setSyncEnabled()` → localStorage

**`src/crypto/index.ts`** — Public API barrel export

**`src/crypto/errors.ts`** — Typed error classes

### Tests
- `src/crypto/primitives.test.ts`
- `src/crypto/canary.test.ts`
- `src/crypto/recovery-key.test.ts`
- `src/crypto/key-storage.test.ts`

### Reusable from #465
- `src/crypto/primitives.ts` — AES-GCM encrypt/decrypt (adapt, add RSA-OAEP ops)
- `src/crypto/canary.ts` — same concept, minor API changes
- `src/crypto/format.ts` → becomes `recovery-key.ts` (hex encode/decode reusable)
- `src/crypto/errors.ts` — reusable as-is
- `src/crypto/key-storage.ts` — adapt for new key types (key pair instead of master key)
- Test files — partially reusable

### Verification
- `bun test` — all crypto unit tests pass
- Verify non-extractable keys cannot be exported
- Verify canary round-trip (create → verify)
- Verify wrap → unwrap produces identical CK
- Verify recovery key encode → decode round-trip

---

## PR 5: FE — Integration (API client, service layer, UI wiring, device schema)

**Goal:** Wire crypto module + API + UI together. Update FE device schema. Mechanism-independent — encryption is NOT yet connected to sync. Data syncs unencrypted until PR 6.1 or 6.2.

### Update FE device schema
- `src/db/tables.ts` — add `status` and `publicKey` columns to devicesTable
- `src/dal/devices.ts` — `DeviceStatus` type, `getPendingDevices()` query
- `src/dal/index.ts` — updated exports

### API client
**`src/api/encryption.ts`** — API functions using `ky`
- `registerDevice(deviceId, publicKey)` → POST /devices
- `storeEnvelope(deviceId, wrappedCK, canary?)` → POST /devices/:id/envelope
- `fetchMyEnvelope()` → GET /devices/me/envelope
- `fetchCanary()` → GET /encryption/canary

### Service layer
**`src/services/encryption.ts`** — Orchestrates crypto + API
- `setupFirstDevice()` — Flow C: generate keys, CK, canary, envelope, return recovery key
- `requestDeviceApproval()` — Flow D (new device side): generate keys, register, wait
- `approveDevice(pendingDeviceId)` — Flow D (trusted device side): wrap CK with pending device's public key
- `recoverWithKey(recoveryKeyHex)` — Flow E: verify canary, create envelope
- `recoverCKFromEnvelope()` — Flow F: fetch envelope, unwrap CK
- `checkApprovalAndUnwrap()` — Flow D continue: check if approved, unwrap CK
- `handleSignOut()` — Flow G: clear CK, keep key pair
- `handleFullWipe()` — Flow H: clear all keys

### Wire UI to service layer
- `src/hooks/use-sync-setup.ts` — real async service calls replacing stubs, loading/error state
- `src/components/sync-setup/sync-setup-modal.tsx` — wired to real services, loading/error in steps
- `src/settings/devices.tsx` — real synced data via `getPendingDevices`, real approve mutation

### Files to modify
- `src/db/tables.ts` — add status + publicKey columns
- `src/dal/devices.ts` — update types + add helpers
- `src/dal/index.ts` — updated exports
- `src/api/encryption.ts` — new API client
- `src/services/encryption.ts` — new service layer
- `src/hooks/use-sync-setup.ts` — replace stubs with real calls
- `src/components/sync-setup/sync-setup-modal.tsx` — wire to services
- `src/settings/devices.tsx` — replace mocks with real synced data

### Verification
- `bun run typecheck` passes
- Sync setup wizard calls real API endpoints
- First device flow: generates keys, stores envelope, shows recovery key
- Approval flow: wraps CK, stores envelope for pending device
- Devices page: real pending/trusted data from PowerSync
- Encryption NOT yet connected (data syncs unencrypted until 6.1 or 6.2)

---

## PR 6.1: Trigger-based encryption (shadow tables + watchers)

**Goal:** Connect encryption to sync using trigger-based shadow tables from PR #465.

### What it contains
- `src/db/encryption/config.ts` — table → encrypted columns mapping
- `src/db/encryption/enabled.ts` — global toggle
- `src/db/encryption/codec.ts` — async AES-GCM codec using CK from IndexedDB
- `src/db/encryption/shadow-tables.ts` — auto-generated `*_decrypted` local tables
- `src/db/encryption/watcher.ts` — trigger-based decryption into shadow tables
- `src/db/encryption/upload-encoder.ts` — encode columns before upload
- `src/db/encryption/dal-helpers.ts` — COALESCE queries preferring shadow values
- `src/db/encryption/index.ts` — barrel export
- `src/lib/base64.ts` — base64 utilities
- `src/lib/reconcile-defaults.ts` — decode encrypted defaults
- `src/dal/*.ts` — all DAL modules updated for `decryptedSelectFor()`
- `src/db/powersync/schema.ts` — register shadow tables
- `src/db/powersync/connector.ts` — call async `encodeForUpload()`
- `src/db/powersync/database.ts` — setup decryption watchers on connect
- `src/db/apply-schema.ts` — shadow table creation

### Verification
- Encrypted data uploads with `__enc:` prefix
- Shadow tables auto-populated via trigger watchers
- DAL reads COALESCE from shadow tables
- Recovery key flow decrypts canary correctly

---

## PR 6.2: Middleware-based encryption (PowerSync sync middleware)

**Goal:** Connect encryption to sync using PowerSync middleware from PR #429.

### What it contains
- `src/db/powersync/TransformableBucketStorage.ts` — extends SqliteBucketStorage with transform pipeline
- `src/db/powersync/ThunderboltPowerSyncDatabase.ts` — custom database class using TransformableBucketStorage
- `src/db/powersync/middleware/EncryptionMiddleware.ts` — decrypts incoming sync data before SQLite write (config-driven, all tables)
- `src/db/powersync/worker/` — custom SharedWorker for transformers
- `src/db/powersync/connector.ts` — encode columns before upload
- `src/db/powersync/database.ts` — use ThunderboltPowerSyncDatabase + register middleware
- Upload encoding (same approach as 6.1)
- No shadow tables, no watchers, no DAL changes — data is decrypted before storage

### Verification
- Encrypted data uploads with `__enc:` prefix
- Middleware decrypts before SQLite write
- DAL reads directly (no joins needed)
- Recovery key flow decrypts canary correctly

---

## Key difference between approaches

| Aspect | 6.1 Trigger (shadow tables) | 6.2 Middleware (sync transform) |
|--------|---------------------------|-------------------------------|
| Where decryption happens | After data lands in SQLite, via triggers → shadow tables | Before data lands in SQLite, via middleware intercept |
| Storage | Two tables per encrypted table (source + shadow) | Single table (data stored decrypted) |
| DAL impact | All DAL queries need COALESCE joins | No DAL changes needed |
| Upload encoding | Same (encode before upload) | Same (encode before upload) |
| Complexity | Higher (shadow tables, triggers, DAL helpers) | Lower (single middleware, no DAL changes) |
| Data at rest | Encrypted in source table, decrypted in shadow | Decrypted in single table |

PRs 6.1 and 6.2 are **alternatives** — both branch off PR 5, only one merges.

---

## Merge order

```
PR 1 (FE UI mocks) — zero dependencies, merge immediately
  ↓
PR 2 (backend schema) — deploy + run migration
  ↓
PR 3 (backend API) + PR 4 (FE crypto) — can develop & merge in parallel
  ↓
PR 5 (integration — API client, services, UI wiring, device schema)
  ↓
PR 6.1 (trigger approach) OR PR 6.2 (middleware approach)
```

- **PR 1** lands first with zero risk — pure UI, no schema/crypto/API dependencies
- **PR 2** deploys backend schema changes
- **PRs 3 & 4** have no code dependency on each other — develop and review in parallel
- **PR 5** wires everything together (mechanism-independent) — data syncs unencrypted
- **PR 6.1 or 6.2** connects encryption to sync — only one merges after comparing both approaches
