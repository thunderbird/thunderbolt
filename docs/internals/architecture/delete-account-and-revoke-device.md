# Delete Account and Revoke Device Access

**Policy** (AGENTS.md / CLAUDE.md): the frontend never hard deletes; the backend does so only where required. Account deletion is one of those cases, and the frontend only triggers it via `DELETE /v1/account`.

## Overview

| Action         | Where                  | Backend / sync behavior                                                             | Other device behavior                                                                                               |
| -------------- | ---------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Delete account | Settings > Preferences | User row hard-deleted (cascades); **410** `ACCOUNT_DELETED` on token refresh        | Full `clearLocalData()` and redirect to `/account-deleted`, triggered by the 410 or by its own device row vanishing |
| Revoke device  | Settings > Devices     | Envelope deleted, `revoked_at` set, sessions revoked; **403** `DEVICE_DISCONNECTED` | Full `clearLocalData()` and redirect to `/device-revoked`, triggered by the synced row or the 403                   |

Both end the same way. Revocation is the action you take for a lost or stolen device, and asking the device itself whether to keep its data would hand that choice to whoever is holding it. It finds out the next time it reaches the server, even with its session already gone: the session check answers a revoked device with a 403 `DEVICE_DISCONNECTED`. A device that never comes back online never finds out and keeps what it has — revocation is not a remote wipe.

## User Flows

### Delete Account

1. User confirms "Delete My Account" in **Settings > Preferences**.
2. `handleDeleteAccount` calls `DELETE /v1/account`, then runs `clearLocalData()` and reloads (`src/settings/preferences.tsx:538-552`).
3. The backend deletes the `user` row (`backend/src/dal/users.ts:28`); the synced tables cascade on `user_id`.
4. Each **other signed-in device** clears local data and redirects to `/account-deleted`, triggered by whichever comes first:
   - A token refresh answered **410 Gone** with `code: 'ACCOUNT_DELETED'` (`backend/src/api/powersync.ts:229-232`).
   - Sync removing the account's rows, so the device sees its own `devices` row is gone (`src/hooks/use-powersync-credentials-invalid-listener.ts`).

### Revoke Device

1. User confirms "Revoke" on another device in **Settings > Devices**.
2. `useRevokeDevice` (`src/hooks/use-revoke-device.ts`) runs `revokeDeviceAndRotate` (`src/services/encryption.ts`) on a device holding the account keys, and a bare `revokeDeviceWithProof` on a pre-E2EE account.
3. `POST /v1/account/devices/:id/revoke` carries a `revoke` challenge proof signed with the canary-derived key; pre-E2EE accounts and v1 leftovers send none. In one transaction the backend deletes the device's envelope, sets `revoked_at`, and revokes that device's sessions. PowerSync syncs the row to all clients.
4. `POST /v1/encryption/rotate` then replaces the account key and mints a new primary data key, with envelopes for every device except the revoked one. If it fails, the server reports the device as awaiting lockout and any trusted device can finish it ([e2e-encryption.md](e2e-encryption.md#device-revocation)).
5. The revoked device resets on whichever comes first: the watched `revokedAt` on its synced row, or a **403** `code: 'DEVICE_DISCONNECTED'`. Revocation deletes its sessions, so that 403 comes from the session check (`backend/src/auth/elysia-plugin.ts`): the app runs it on every start, with or without a stored session, and once more after our backend answers with a 401, because a 401 alone can't tell an expired session from a revoked device.

It clears everything — database, attachments, encryption keys, auth token, device id and web storage — and lands on `/device-revoked`. Anything still queued for upload is lost, since uploads from a revoked device are refused.

## Backend Routes

All routes sit under `/v1` (`backend/src/index.ts:66`) and are specified in [PowerSync, Account & Device Management](powersync-account-devices.md#6-backend-api):

- `DELETE /v1/account`
- `GET /v1/powersync/token`, `PUT /v1/powersync/upload` (full status/`code` table, and which codes the client turns into a reset)
- `POST /v1/account/devices/:id/revoke`, and the narrow `DELETE /v1/devices/:deviceId`

The `devices` table (columns, state combinations, server-managed columns, and the `localStorage` device id that `X-Device-ID` carries) is in [section 5](powersync-account-devices.md#5-device-management).

Three properties of those routes drive the flows above:

- **`X-Device-ID` is required, not optional.** Revocation is recorded on the device row, so the header is mandatory to stop a revoked device bypassing the check by dropping it.
- **Revocation deletes the envelope.** The wrapped Content Key is gone, so the CK is unrecoverable even if the device's private key leaks.
- **Revocation is idempotent.** `revokeDevice` matches only non-revoked rows, so a second revoke is a no-op rather than a second session purge.

## Frontend

### Credentials-Invalid Handling

The connector maps a rejected token request to a `CredentialsInvalidReason` (`src/db/powersync/connector.ts:23-29`) and dispatches `powersync_credentials_invalid`; `usePowerSyncCredentialsInvalidListener` branches on it.

| Reason                                  | What happens                                                           | What survives                        |
| --------------------------------------- | ---------------------------------------------------------------------- | ------------------------------------ |
| `account_deleted`                       | `clearLocalData()`, then `window.location.replace('/account-deleted')` | nothing local                        |
| `device_id_taken`, `device_id_required` | the same reset, redirecting to `/`                                     | nothing local                        |
| `device_revoked`                        | the same reset, redirecting to `/device-revoked`                       | nothing local                        |
| `session_expired`                       | `clearAuthToken()`, `setSyncEnabled(false)`, sign-in modal             | database, encryption keys, device id |
| `sync_not_permitted`                    | `setSyncEnabled(false)` only                                           | everything, including the auth token |

Revocation and deletion outrank session expiry: once a reset or the sign-in modal is under way, a later `session_expired` is ignored so no sign-in prompt lands on top of a reset. `sign_in_success` clears the latch after re-authentication, so a later expiry can prompt again (`src/hooks/use-powersync-credentials-invalid-listener.ts`).

`clearLocalData` (`src/lib/cleanup.ts`) is the one teardown, shared by reset and sign-out. It always clears identity-scoped memory and disposes warm ACP adapters, then runs four independently skippable groups:

1. Disable sync.
2. Wipe encryption keys.
3. `resetAppDir()`, attachments, the local-settings store and cached locale, then — after group 4, so other tabs see the sign-out — all of `localStorage` and `sessionStorage`.
4. Clear the auth token, device id, user cache secret, iroh client secret and cached session.

Each step logs and continues on failure so one bad step can't strand the user half-signed-out. Callers navigate, not `clearLocalData`; reset uses `window.location.replace` rather than a reload so the cleared state isn't reachable with Back.

### Devices Watcher

The listener also watches the current device's synced row via `useQuery` over `getDevice(deviceId)` (`src/hooks/use-powersync-credentials-invalid-listener.ts`):

- **`revokedAt` set**: reset to `/device-revoked`, exactly as the 403 does. The row survives the revocation because it also rides the ungated `device_self` bucket.
- **Row missing**: reset, but only if the row was already seen this session (`hadDeviceOnceRef`). On a cold start the devices table may not have synced yet, and treating that as "account deleted" would clear storage and sign the user out after an ordinary refresh.

### Settings > Devices Page

`src/settings/devices.tsx` renders two lists from live PowerSync queries (`useQuery` from `@powersync/tanstack-react-query`, `:278-285`). No mutation invalidates a query key: the queries re-run on table change, so the lists settle once the write syncs back.

- **Pending approvals**: untrusted, non-revoked, `approval_pending` devices whose `device_type` is `normal` or unset (`src/dal/devices.ts:43-56`). Approve re-wraps the Content Key to the pending device's public keys and stores the envelope (`src/services/encryption.ts:162-192`, `src/hooks/use-approve-device.ts:14-26`); Deny clears `approval_pending` without revoking, so the device can ask again (`src/hooks/use-deny-device.ts:15-21`).
- **Trusted devices**: a revoked row lingers 24 hours so the revocation is visible, then drops off; untrusted rows are never listed here (`:53-54`, `:288-293`).
- **Revoke** shows on other, non-revoked devices; **Remove** only on a revoked bridge, matching the backend's constraint (`:197-221`, `src/hooks/use-remove-device.ts:12-18`).
- **Pairing identity**: on `bridge` devices and those whose `device_type` is `normal` or unset, the row shows `node_id`, a dialog to set or update it, and a QR code carrying `encodePairingTicket({ nodeId, name })` (`:225-267`).
