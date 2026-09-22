# Delete Account and Revoke Device Access

This document describes how account deletion and device revoke work, and what happens on the account's other devices when either is triggered elsewhere.

**Policy**: Per project rules (see AGENTS.md / CLAUDE.md), the frontend never hard deletes; the backend uses hard delete only where required. Account deletion is one of those cases—the backend permanently removes the user and related data; the frontend only triggers it via `DELETE /v1/account`.

## Overview

- **Delete account**: The user can permanently delete their account from **Settings > Preferences**. All data is removed on the backend, and every other signed-in device wipes its local data and lands on `/account-deleted`.
- **Revoke device**: In **Settings > Devices**, the user sees the devices on the account and can revoke one. The revoked device loses sync access and is shown a blocking modal; its local data stays unless the user chooses to delete it.

The two outcomes differ on purpose. Deleting the account destroys the data everywhere, so the local copy has nothing left to belong to and is cleared without asking. Revoking a device only ends that device's access to sync — its database is still usable offline, which is what the modal offers to keep (`src/components/revoked-device-modal.tsx:30-34`, `:53-68`).

Every route named here sits under the backend's `/v1` prefix (`backend/src/index.ts:66`); the routes themselves are specified in [PowerSync, Account & Device Management](./powersync-account-devices.md#6-backend-api).

## User Flows

### Delete Account

1. User goes to **Settings > Preferences** and chooses “Delete My Account” (with confirmation).
2. `handleDeleteAccount` calls `DELETE /v1/account`, then runs `clearLocalData()` and reloads (`src/settings/preferences.tsx:538-552`).
3. The backend deletes the `user` row (`backend/src/dal/users.ts:28`); the synced tables cascade on `user_id`.
4. On **other devices** that were signed in, either signal triggers the reset:
   - PowerSync refreshes its token and the backend answers **410 Gone** with `code: 'ACCOUNT_DELETED'` (`backend/src/api/powersync.ts:229-232`).
   - Or sync removes the account's rows first and the device notices its own `devices` row has disappeared (`src/hooks/use-powersync-credentials-invalid-listener.ts:164-167`).

   Either path clears local data and redirects to `/account-deleted`.

### Revoke Device

1. User goes to **Settings > Devices** and chooses “Revoke” on another device (with confirmation).
2. The frontend calls `POST /v1/account/devices/:id/revoke` through `revokeDeviceWithProof` (`src/hooks/use-revoke-device.ts:14-20`), which attaches a canary secret as proof-of-CK-possession when E2EE is active and omits it for accounts that never set up encryption (`src/services/encryption.ts:222-233`).
3. The backend deletes the device's envelope, sets `revoked_at`, and revokes that device's sessions. PowerSync syncs the updated `devices` row to all clients.
4. On the **revoked device**:
   - **Immediate**: the app watches the current device's synced row; once `revokedAt` is set it opens the revoked-device modal (`src/hooks/use-powersync-credentials-invalid-listener.ts:153-162`).
   - **On token refresh**: the backend returns **403** with `code: 'DEVICE_DISCONNECTED'`, which maps to the same modal (`src/db/powersync/connector.ts:43-63`).

The modal cannot be dismissed and offers “Keep data on device” or “Delete data from device”. Both choices disable sync, wipe the encryption keys, and clear the auth token and device id before redirecting to `/`; only the second also deletes the local database (`src/components/revoked-device-modal.tsx:30-34`, `src/lib/cleanup.ts:33-87`).

## Backend Routes

The routes these flows call are specified in [PowerSync, Account & Device Management](./powersync-account-devices.md#6-backend-api): `DELETE /v1/account`, `GET /v1/powersync/token` and `PUT /v1/powersync/upload` — including the full status/`code` table and which of those codes the client turns into a reset — plus `POST /v1/account/devices/:id/revoke` and the narrow `DELETE /v1/devices/:deviceId`. The `devices` table itself (every column, the state combinations, which columns are server-managed, and the `localStorage` device id that `X-Device-ID` carries) is in [section 5](./powersync-account-devices.md#5-device-management).

Three properties of those routes are what make the flows above behave the way they do:

- **`X-Device-ID` is required, not optional.** Revocation is recorded on the device row, so a request that omitted the header could not be checked against it — the header is mandatory precisely so a revoked device cannot bypass the check by dropping it.
- **Revocation deletes the envelope.** The wrapped Content Key is gone, so the CK cannot be recovered later even if the device's private key leaks; that is why the modal's "keep data" option still cannot resume sync.
- **Revocation is idempotent.** `revokeDevice` matches only non-revoked rows, so a second revoke is a no-op rather than a second session purge.

## Frontend

### Credentials-Invalid Handling

The connector maps a rejected token request to a `CredentialsInvalidReason` (`src/db/powersync/connector.ts:23-29`) and dispatches the `powersync_credentials_invalid` event. `usePowerSyncCredentialsInvalidListener` branches on the reason; only two branches clear anything.

| Reason                                  | What happens                                                           | What survives                         |
| --------------------------------------- | ---------------------------------------------------------------------- | ------------------------------------- |
| `account_deleted`                       | `clearLocalData()`, then `window.location.replace('/account-deleted')` | nothing local                         |
| `device_id_taken`, `device_id_required` | the same reset, redirecting to `/`                                     | nothing local                         |
| `device_revoked`                        | revoked-device modal; the user decides whether the database goes       | everything, pending the user's choice |
| `session_expired`                       | `clearAuthToken()`, `setSyncEnabled(false)`, sign-in modal             | database, encryption keys, device id  |
| `sync_not_permitted`                    | `setSyncEnabled(false)` only                                           | everything, including the auth token  |

A revocation or deletion outranks a session expiry: once the revoked or sign-in modal has been dispatched, a later `session_expired` is ignored so a sign-in prompt cannot land on top of a reset. `sign_in_success` clears that latch after re-authentication, so a future expiry can prompt again (`src/hooks/use-powersync-credentials-invalid-listener.ts:85-139`).

`clearLocalData` (`src/lib/cleanup.ts:33-87`) is the one teardown used by reset, sign-out and the revoked-device modal. It always clears identity-scoped memory and disposes every warm ACP adapter, then runs four independently skippable groups: disable sync, wipe encryption keys, `resetAppDir()` plus the local-settings store and cached locale, and clear the auth token, device id, user cache secret, iroh client secret and cached session. Each step logs and continues on failure so one bad step can't strand the user half-signed-out. It never navigates — callers do, and reset uses `window.location.replace` rather than a reload so the cleared state isn't reachable with Back.

### Devices Watcher

Alongside the event, the listener watches the current device's synced row with a PowerSync `useQuery` over `getDevice(deviceId)` (`src/hooks/use-powersync-credentials-invalid-listener.ts:77-80`):

- **`revokedAt` set** — open the revoked-device modal, exactly as the 403 does.
- **Row missing** — reset, but only if the row had already been seen in this session (`hadDeviceOnceRef`). On a cold start the devices table may not have synced yet, and treating that as “account deleted” would clear storage and sign the user out after an ordinary refresh (`src/hooks/use-powersync-credentials-invalid-listener.ts:38-45`, `:142-168`).

### Settings > Devices Page

`src/settings/devices.tsx` renders two lists from live PowerSync queries (`useQuery` from `@powersync/tanstack-react-query`, `:278-285`). Nothing invalidates a query key after a mutation: the queries re-run when the underlying table changes, so the list settles on its own once the write syncs back.

- **Pending approvals** — untrusted, non-revoked, `approval_pending` devices whose `device_type` is `normal` or unset (`src/dal/devices.ts:43-56`), each with Approve and Deny. Approve re-wraps the Content Key to the pending device's public keys and stores the envelope (`src/services/encryption.ts:162-192`, `src/hooks/use-approve-device.ts:14-26`); Deny clears `approval_pending` without revoking, so the device can ask again (`src/hooks/use-deny-device.ts:15-21`).
- **Trusted devices** — a revoked row lingers for 24 hours so the revocation is visible, then drops out of the list; an untrusted row is never listed here (`:53-54`, `:288-293`).
- **Revoke** is offered for other, non-revoked devices. **Remove** appears only on a revoked bridge, matching the backend's constraint (`:197-221`, `src/hooks/use-remove-device.ts:12-18`).
- **Pairing identity** — for `bridge` devices and those whose `device_type` is `normal` or unset, the row shows the device's `node_id`, a dialog to set or update it, and a QR code carrying `encodePairingTicket({ nodeId, name })` (`:225-267`).

## Summary

| Action         | Where       | Backend / sync behavior                                                             | Other device behavior                                                                                               |
| -------------- | ----------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Delete account | Preferences | User row hard-deleted (cascades); **410** `ACCOUNT_DELETED` on token refresh        | Full `clearLocalData()` and redirect to `/account-deleted`, triggered by the 410 or by its own device row vanishing |
| Revoke device  | Devices     | Envelope deleted, `revoked_at` set, sessions revoked; **403** `DEVICE_DISCONNECTED` | Revoked-device modal from the synced row or the 403; local database kept unless the user chooses to delete it       |

The two are not the same flow: deletion always wipes the device, revocation leaves the choice to the user.
