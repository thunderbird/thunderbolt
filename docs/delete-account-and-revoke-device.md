# Delete Account and Revoke Device Access

This document describes how account deletion and device revoke work, and how other devices are reset gracefully when the user deletes their account or revokes a device from elsewhere.

**Policy**: Per project rules (see AGENTS.md / CLAUDE.md), the frontend never hard deletes; the backend uses hard delete only where required. Account deletion is one of those cases—the backend permanently removes the user and related data; the frontend only triggers it via `DELETE /v1/account`.

## Overview

- **Delete account**: The user can permanently delete their account from **Settings > Preferences**. All data is removed on the backend. Other signed-in devices must reset locally so they don’t crash when PowerSync syncs empty data.
- **Revoke device**: In **Settings > Devices**, the user sees a list of devices that have signed in. They can revoke a device; that device is then signed out and its local data is cleared on next sync (or as soon as it sees the revoked state).

Both flows rely on the same **graceful reset**: disable sync, clear localStorage, reset the app directory (DB and related files), and reload. The user lands on a clean, signed-out state.

## User flows

### Delete account

1. User goes to **Settings > Preferences** and chooses “Delete my account” (with confirmation).
2. Frontend calls `DELETE /v1/account` with the current auth token. Backend deletes the user and all related data (settings, chats, models, devices, etc.).
3. On **other devices** that were signed in:
   - When PowerSync tries to refresh the token, the backend returns **410 Gone** with `code: 'ACCOUNT_DELETED'`.
   - The frontend treats this as “credentials invalid” and runs the reset flow (see below).
   - Alternatively, PowerSync may sync DELETE operations and empty the local DB; without the 410 path, that could cause crashes. The 410 path triggers a full reset before or when that happens.

### Revoke device

1. User goes to **Settings > Devices**, sees a list of devices (name, last seen, “This device”, “Revoked”).
2. User chooses “Revoke” on another device (with confirmation). Frontend calls `POST /v1/account/devices/:id/revoke`.
3. Backend sets `revoked_at` on that device row (soft revoke). PowerSync syncs the updated `devices` table to all clients.
4. On the **revoked device**:
   - **Immediate**: The app watches the current device’s row via React Query (`getDevice(deviceId)`). When the synced row has `revoked_at` set, the app runs the same reset flow.
   - **On token refresh**: When PowerSync refreshes the token, the backend returns **403 Forbidden** with `code: 'DEVICE_DISCONNECTED'`. The connector dispatches the same “credentials invalid” event and the app resets.

So revoke is visible either as soon as the `devices` row syncs or when the next token refresh returns 403.

## Backend

### PowerSync token endpoint (`GET /powersync/token`)

- **Authenticated (session)**  
  If the request includes `X-Device-ID`:
  - The backend checks the `devices` row for that id. If `revoked_at` is set, it returns **403** with `{ code: 'DEVICE_DISCONNECTED' }` and does not issue a token.
  - Otherwise it issues a PowerSync JWT and upserts the device (id, user_id, name, last_seen, created_at).
- **Bearer token only (e.g. PowerSync credential refresh)**  
  Backend resolves the session from the Bearer token, then looks up the user:
  - If the user no longer exists (account deleted), it returns **410 Gone** with `{ code: 'ACCOUNT_DELETED' }`.
  - Otherwise it returns **401** (e.g. invalid/expired token).

So:

- **410** = account deleted (client should reset).
- **403** with `DEVICE_DISCONNECTED` = this device was revoked (client should reset).
- **401** = generic auth failure (e.g. token refresh in the future, not necessarily a full reset).

### Revoke device endpoint (`POST /v1/account/devices/:id/revoke`)

- Requires an authenticated user (session).
- Sets `revoked_at` to the current timestamp for the device `id` that belongs to the current user.
- Returns **204** on success (idempotent for already-revoked devices).

### Devices table

- **Backend**: `devices` table with `id`, `user_id`, `name`, `last_seen`, `created_at`, `revoked_at`. Synced via PowerSync.
- **Frontend**: Same schema in the local DB; `devices` is in the PowerSync schema so it syncs. Used for the Settings > Devices list and for “current device revoked?” checks.

## Frontend

### Credentials-invalid handling

When the app should reset (account deleted or device revoked), it runs a single flow:

1. `setSyncEnabled(false)` – disconnect from PowerSync.
2. `localStorage.clear()` – remove auth token and device id (and any other local state).
3. `resetAppDir()` – clear the app directory (DB and related files).
4. `window.location.reload()` – reload so the app starts from a clean, signed-out state.

This is triggered in two ways:

1. **Event `POWERSYNC_CREDENTIALS_INVALID`**  
   The PowerSync connector dispatches this when:
   - The token request returns **410** (account deleted), or
   - The token request returns **403** with body `code: 'DEVICE_DISCONNECTED'` (and a token was sent).  
     So any token refresh that gets 410 or 403 (revoked) leads to reset.

2. **Devices table (current device revoked)**  
   `usePowerSyncCredentialsInvalidListener` uses React Query with `getDevice(deviceId)` and query key `['devices', deviceId]`. When the `devices` table is invalidated (e.g. by PowerSync sync), the query refetches. If the current device’s row has `revoked_at` set, the hook runs the same reset flow. That gives an immediate reset as soon as the revoked state syncs, without waiting for the next token refresh.

### Auth token and device id

- **Auth token**: Stored in `localStorage` under a fixed key. Not synced. Cleared on reset via `localStorage.clear()`.
- **Device id**: Stored in `localStorage` to identify this device. Sent as `X-Device-ID` (and optional `X-Device-Name`) on PowerSync token requests so the backend can register/update the device and enforce revoke.

### Settings > Devices page

- Lists devices from the local DB (synced `devices` table) via `getAllDevices()` and React Query key `['devices']`.
- Shows name, last seen, “This device” for the current device, and “Revoked” when `revoked_at` is set.
- “Revoke” is shown only for other, non-revoked devices; it calls `POST /v1/account/devices/:id/revoke` and then invalidates `['devices']` so the list updates after sync.

## Summary

| Action         | Where       | Backend / sync behavior                              | Other device behavior                                                             |
| -------------- | ----------- | ---------------------------------------------------- | --------------------------------------------------------------------------------- |
| Delete account | Preferences | User and data deleted; 410 on token refresh          | Reset when 410 received or when devices table / sync reflects deletion            |
| Revoke device  | Devices     | Set `revoked_at`; 403 on that device’s token refresh | Revoked device resets when it sees `revoked_at` (useQuery) or gets 403 on refresh |

Both paths trigger the same reset: disable sync, clear localStorage, reset app dir, reload.
