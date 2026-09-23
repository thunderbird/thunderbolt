# Delete Account and Revoke Device Access

**Policy** (AGENTS.md / CLAUDE.md): the frontend never hard deletes; the backend does so only where required. Account deletion is one of those cases, and the frontend only triggers it via `DELETE /v1/account`.

## Overview

| Action         | Where                  | Backend / sync behavior                                                             | Other device behavior                                                                                               |
| -------------- | ---------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Delete account | Settings > Preferences | User row hard-deleted (cascades); **410** `ACCOUNT_DELETED` on token refresh        | Full `clearLocalData()` and redirect to `/account-deleted`, triggered by the 410 or by its own device row vanishing |
| Revoke device  | Settings > Devices     | Envelope deleted, `revoked_at` set, sessions revoked; **403** `DEVICE_DISCONNECTED` | Revoked-device modal from the synced row or the 403; local database kept unless the user chooses to delete it       |

The outcomes differ on purpose: a deleted account leaves the local copy nothing to belong to, while a revoked device's database is still usable offline, which is what the modal offers to keep (`src/components/revoked-device-modal.tsx:30-34`, `:53-68`).

## User Flows

### Delete Account

1. User confirms "Delete My Account" in **Settings > Preferences**.
2. `handleDeleteAccount` calls `DELETE /v1/account`, then runs `clearLocalData()` and reloads (`src/settings/preferences.tsx:538-552`).
3. The backend deletes the `user` row (`backend/src/dal/users.ts:28`); the synced tables cascade on `user_id`.
4. Each **other signed-in device** clears local data and redirects to `/account-deleted`, triggered by whichever comes first:
   - A token refresh answered **410 Gone** with `code: 'ACCOUNT_DELETED'` (`backend/src/api/powersync.ts:229-232`).
   - Sync removing the account's rows, so the device sees its own `devices` row is gone (`src/hooks/use-powersync-credentials-invalid-listener.ts:164-167`).

### Revoke Device

1. User confirms "Revoke" on another device in **Settings > Devices**.
2. `revokeDeviceWithProof` calls `POST /v1/account/devices/:id/revoke` (`src/hooks/use-revoke-device.ts:14-20`), attaching a canary secret as proof-of-CK-possession when E2EE is active and omitting it otherwise (`src/services/encryption.ts:222-233`).
3. The backend deletes the device's envelope, sets `revoked_at`, and revokes that device's sessions. PowerSync syncs the row to all clients.
4. The revoked device opens the modal on whichever comes first: the watched `revokedAt` on its synced row (`src/hooks/use-powersync-credentials-invalid-listener.ts:153-162`), or a **403** `code: 'DEVICE_DISCONNECTED'` on token refresh (`src/db/powersync/connector.ts:43-63`).

The modal cannot be dismissed. "Keep data on device" and "Delete data from device" both disable sync, wipe encryption keys, and clear the auth token and device id before redirecting to `/`; only the second drops the local database (`src/components/revoked-device-modal.tsx:30-34`, `src/lib/cleanup.ts:33-87`).

## Backend Routes

All routes sit under `/v1` (`backend/src/index.ts:66`) and are specified in [PowerSync, Account & Device Management](./powersync-account-devices.md#6-backend-api):

- `DELETE /v1/account`
- `GET /v1/powersync/token`, `PUT /v1/powersync/upload` (full status/`code` table, and which codes the client turns into a reset)
- `POST /v1/account/devices/:id/revoke`, and the narrow `DELETE /v1/devices/:deviceId`

The `devices` table (columns, state combinations, server-managed columns, and the `localStorage` device id that `X-Device-ID` carries) is in [section 5](./powersync-account-devices.md#5-device-management).

Three properties of those routes drive the flows above:

- **`X-Device-ID` is required, not optional.** Revocation is recorded on the device row, so the header is mandatory to stop a revoked device bypassing the check by dropping it.
- **Revocation deletes the envelope.** The wrapped Content Key is gone, so the CK is unrecoverable even if the device's private key leaks. Hence "keep data" cannot resume sync.
- **Revocation is idempotent.** `revokeDevice` matches only non-revoked rows, so a second revoke is a no-op rather than a second session purge.

## Frontend

### Credentials-Invalid Handling

The connector maps a rejected token request to a `CredentialsInvalidReason` (`src/db/powersync/connector.ts:23-29`) and dispatches `powersync_credentials_invalid`; `usePowerSyncCredentialsInvalidListener` branches on it.

| Reason                                  | What happens                                                           | What survives                         |
| --------------------------------------- | ---------------------------------------------------------------------- | ------------------------------------- |
| `account_deleted`                       | `clearLocalData()`, then `window.location.replace('/account-deleted')` | nothing local                         |
| `device_id_taken`, `device_id_required` | the same reset, redirecting to `/`                                     | nothing local                         |
| `device_revoked`                        | revoked-device modal; the user decides whether the database goes       | everything, pending the user's choice |
| `session_expired`                       | `clearAuthToken()`, `setSyncEnabled(false)`, sign-in modal             | database, encryption keys, device id  |
| `sync_not_permitted`                    | `setSyncEnabled(false)` only                                           | everything, including the auth token  |

Revocation and deletion outrank session expiry: once the revoked or sign-in modal is dispatched, a later `session_expired` is ignored so no sign-in prompt lands on top of a reset. `sign_in_success` clears the latch after re-authentication, so a later expiry can prompt again (`src/hooks/use-powersync-credentials-invalid-listener.ts:85-139`).

`clearLocalData` (`src/lib/cleanup.ts:33-87`) is the one teardown, shared by reset, sign-out and the revoked-device modal. It always clears identity-scoped memory and disposes warm ACP adapters, then runs four independently skippable groups:

1. Disable sync.
2. Wipe encryption keys.
3. `resetAppDir()` plus the local-settings store and cached locale.
4. Clear the auth token, device id, user cache secret, iroh client secret and cached session.

Each step logs and continues on failure so one bad step can't strand the user half-signed-out. Callers navigate, not `clearLocalData`; reset uses `window.location.replace` rather than a reload so the cleared state isn't reachable with Back.

### Devices Watcher

The listener also watches the current device's synced row via `useQuery` over `getDevice(deviceId)` (`src/hooks/use-powersync-credentials-invalid-listener.ts:77-80`):

- **`revokedAt` set**: open the revoked-device modal, exactly as the 403 does.
- **Row missing**: reset, but only if the row was already seen this session (`hadDeviceOnceRef`). On a cold start the devices table may not have synced yet, and treating that as "account deleted" would clear storage and sign the user out after an ordinary refresh (`:38-45`, `:142-168`).

### Settings > Devices Page

`src/settings/devices.tsx` renders two lists from live PowerSync queries (`useQuery` from `@powersync/tanstack-react-query`, `:278-285`). No mutation invalidates a query key: the queries re-run on table change, so the lists settle once the write syncs back.

- **Pending approvals**: untrusted, non-revoked, `approval_pending` devices whose `device_type` is `normal` or unset (`src/dal/devices.ts:43-56`). Approve re-wraps the Content Key to the pending device's public keys and stores the envelope (`src/services/encryption.ts:162-192`, `src/hooks/use-approve-device.ts:14-26`); Deny clears `approval_pending` without revoking, so the device can ask again (`src/hooks/use-deny-device.ts:15-21`).
- **Trusted devices**: a revoked row lingers 24 hours so the revocation is visible, then drops off; untrusted rows are never listed here (`:53-54`, `:288-293`).
- **Revoke** shows on other, non-revoked devices; **Remove** only on a revoked bridge, matching the backend's constraint (`:197-221`, `src/hooks/use-remove-device.ts:12-18`).
- **Pairing identity**: on `bridge` devices and those whose `device_type` is `normal` or unset, the row shows `node_id`, a dialog to set or update it, and a QR code carrying `encodePairingTicket({ nodeId, name })` (`:225-267`).
