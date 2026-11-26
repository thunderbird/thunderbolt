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
2. `useDeleteAccount` calls `DELETE /v1/account`, then runs `clearLocalData()` and replaces the current location with `/account-deleted`. Local deletion and the sync listener therefore reach the same confirmation page.
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
3. `resetAppDir()` (which deletes the attachment stores too), the local-settings store and cached locale, then all of `localStorage` and `sessionStorage`. That last step runs after group 4, so other tabs see the sign-out.
4. Clear the auth token, device id, user cache secret, iroh client secret and cached session. An account switch passes `keepSession`, which keeps the auth token and cached session of the account signing in.

Each step logs and continues on failure so one bad step can't strand the user half-signed-out. Callers navigate, not `clearLocalData`; reset uses `window.location.replace` rather than a reload so the cleared state isn't reachable with Back. The account switch below uses `clearLocalDataOrThrow`, which runs the same steps and then rejects if any of them failed.

### Data left on the device (THU-963)

**Leave data on device** keeps the database, and with it the local-only secrets (`mcp_secrets`, `integrations_secrets`, `models_secrets`, `agents_secrets`) and the unsent `ps_crud` queue. `src/lib/local-data-owner.ts` gives each account its own slot: a database file and an attachment store. The account a slot belongs to is its owner. The ownership record (`thunderbolt_local_data` in `localStorage`) names each slot's owner and which slot is active. Boot opens the active slot. The auth client binds every session it learns about to the open slot, synchronously and before React renders it, whichever way the session arrived (OTP, passkey, magic link, SSO, anonymous, cross-tab, re-auth after a 401):

- If the session's account owns the slot, the session continues on it. If the slot has no owner yet (a fresh device), the account claims it and continues.
- If another account owns the slot, the app switches to that account's slot. `AuthProvider` stops rendering the app and `clearLocalDataOrThrow({ clearDatabase: false, keepSession: true })` removes the previous owner's keys and device credentials. The previous owner's account settings (`accountLocalSettingsSchema`: the voice provider and the unsaved recovery phrase reminder) are stashed on that owner's slot. What is tied to the previous owner's database goes: the cached locale, the image-support results and the OAuth flow state of integrations and MCP servers. Then the page reloads into the new account's slot. Attachments need no step, because each slot has its own attachment store (`thunderbolt-files` for the default slot, `thunderbolt-files-<slot>` for the others). If cleanup fails, the new session stays blocked on the "Couldn't switch accounts" screen: **Reload** retries, and **Sign out** drops only the new session. **Sign out** shares `signOutAndLeave` with **Log out`: both require the server to confirm sign-out before clearing the session or leaving the screen. If confirmation fails, the session stays in place and the user can retry. A confirmed SSO sign-out lands on `/signed-out`. A reload would send the browser to the identity provider, which signs the same account straight back in.

A slot with an owner opens `unbound`, and nothing uses it until a session binds or the server says nobody is signed in (a failed `/get-session` says neither). While a failed request keeps it `unbound`, the loading screen says "Waiting for a spark… Thunderbolt opens on its own." Behind the message is a blurred picture of the layout (`AppLayoutSkeleton`). It is plain markup with no data and no hooks, so no app code runs before the session is known. Better Auth requests the session again when the browser comes back online, and the app then opens on its own. While the message shows, `LocalDataGate` retries failed session requests after 30 seconds and lets pending requests finish. This also recovers when the device stays online while the server is down and never gets an `online` event. Boot binds the cached session right after opening the slot, with the checks `hydrateSessionFromCache` makes, so PowerSync, which connects before `AuthProvider` mounts, gets the owner's credentials on its first try. A cached session for another account waits for the session subscriber, which starts the switch. SSO mode binds the cached session the same way, so an offline reload gets the app. The cookie may by then belong to another account than the cached one. The cached owner's data then shows until `/get-session` names the other account, and that answer starts a switch. This trade-off is accepted.

The PowerSync connector refuses credentials whose JWT `sub` is not the open slot's owner. It also refuses uploads unless the profile's cached session belongs to the owner, because PowerSync uploads on connect before any credentials check, and in SSO mode another tab's sign-in gives this tab no token change. OTP and passkey sign-ins bind the returned account themselves (`bindSignedInAccount`), once its token is stored and before the session listeners hear of it. `markOnboardedForReturningUser` then only asks whether that account owns the open slot, and during a switch it defers its write to the new slot. Better Auth publishes the session it already holds again whenever a refetch starts or fails, so the auth client binds neither of those updates. Right after an OTP promotion, the session it holds is still the anonymous one, and binding it would switch away from the slot the sign-in just claimed. `sign-in-with-otp.test.ts` runs the promotion through the app's own auth client to check that the sign-in's own bind comes first. When an OTP or passkey sign-in promotes an anonymous account into a named account, the anonymous slot passes to the named account, unless that account already has a slot on this device. A slot that an anonymous account claims is marked `anonymous`, and the mark goes when the slot passes to a named account. An anonymous account has no way back in without its token, so a later boot deletes each anonymous slot that is not active once that token is gone: no token is stored, or the cached session for the stored token names another account. The token goes after a promotion into an account that already has a slot here, after a sign-out, and when an anonymous session expires and the app starts a new anonymous session in a new slot. Until something proves the token is gone, the slot stays.

**Other tabs.** A tab binds only the sessions it hears about, and a cookie-only SSO tab hears of no token change. So the switching tab takes the origin-wide `thunderbolt-local-data-switch` Web Lock and holds it while it records the switch marker (`switchingTo`), runs cleanup (which takes the separate key-store lock) and moves `active`. Every other tab on the old slot stops rendering at the first of those writes and reloads. Boot takes the same lock for its entire ownership update, waiting however long another tab's cleanup takes. It refreshes the persisted account settings under that lock before opening the active slot, because its in-memory store may still hold the previous account's settings. The browser releases a dead tab's lock, so if the marker is still there once the lock is free, the booting tab clears it and its own session retries the switch. The lock is what tells a live switch from a dead one; there is no timeout. The account settings change hands in three writes, and a crash after any of them leaves each set tied to its account: the outgoing set is saved on its slot, the incoming set goes live, and one record write finishes the switch. Settings saved on the still-active slot can only come from an unfinished switch, so clearing the marker first restores them as the live ones. Web Locks are always there, because PowerSync cannot open a database without them. Tabs whose slot stays active, the normal case for several tabs of one account, are left alone. A full wipe replaces the record, which reloads those tabs too.

**Without OPFS** (a private window, or a browser that lacks it), each slot's database still has its own filename. Browsers other than Safari (the `default` config) store it as an IndexedDB database of that name, so like an OPFS file it outlives the tabs that held it. A private window discards IndexedDB when the window closes. Safari and Tauri (the `safari-tauri` config) keep the database in memory, one per tab: that config avoids the IndexedDB VFS, and these platforms lost the database on every reload before slots too. A plain-HTTP origin never gets this far: browsers give Web Locks only to secure origins, and PowerSync cannot open a database without them ([self-hosting](../../self-hosting/docker-compose.md)). Builds before slots used one `:memory:` name for every account, an in-memory database that every tab of the profile shared, so a tab kept open on A's data handed that data to B. Without OPFS, a fresh record never uses the default slot's name, because that name could belong to an IndexedDB database left by an earlier install, owner unknown.

**Full wipes.** `resetAppDir` closes the open database (PowerSync's `disconnectAndClear`) and lists every IndexedDB database the app names (each recorded slot's database and attachment store, the default ones, the empty `:memory:` database earlier builds created, and any `thunderbolt-sync-<uuid>.db` or `thunderbolt-files-<uuid>` the browser lists). It then replaces the ownership record with one new slot that has no owner, deletes the listed databases and empties the whole OPFS root. So every full wipe removes every account's slot, as it removed the single database before slots. The IndexedDB databases go first, because every attachment store lives there and the OPFS step can fail. A file another tab holds open cannot be removed from OPFS, so the wipe removes every other OPFS entry, leaves the held file, and then fails. The full wipes are **Delete data from device**, **Delete All Local Data**, the credentials-invalid reset, and **Clear Local Database** on the error screen. The record is replaced, not removed, before any file goes, because a wipe can stop partway: another tab can hold a file open, or the tab can close. A boot that found no record would run the upgrade step on whatever survived and give it to the signed-in account. With the new record in place, what survives stays out of reach, and the next full wipe removes it. `clearLocalData` clears all of `localStorage` at the end, record included, but only after the token and cached session are gone, so the upgrade step then has no account to give anything to.

**Upgrading.** A database from before slots is bound to the account signed in at upgrade. With OPFS, a standalone installation keeps its existing database and account settings when its persisted settings explicitly say `localMode: true` and `serverHasAuthenticated: false`. That slot stays unclaimed until the first account signs in. Missing flags do not prove that the data was always local; those installations follow the recovery procedure below. If only that account's token is known, only that token's session can claim it. The ownership record keeps a hash of the token, never the token itself. A database left by an account that had already signed out has no provable owner. The keys, device id and cached session went with the sign-out, so nothing trustworthy on the device ties the database to an account. The app never opens it, and its bytes stay in `thunderbolt-sync.db` until a full wipe. The new slot it opens instead has no owner, and neither does the slot opened after an unreadable record or a full wipe, or on a first boot without OPFS while signed out. Each starts from the default account settings, because the live ones (the voice key among them) may belong to whoever left them. Without OPFS while signed in, the new slot goes to the signed-in account like the default one would, and keeps its settings. Synced data is unaffected: the owner gets it back by signing in and turning sync on. To recover local-only data (unsynced chats, saved credentials), the person who left it signs in on that device and runs the snippet below in the developer console. The snippet moves that account's post-upgrade slot aside, so use it only on a device that person controls:

```js
const record = JSON.parse(localStorage.thunderbolt_local_data)
const me = JSON.parse(localStorage.thunderbolt_session_cache).user.id
for (const slot of Object.values(record.slots)) if (slot.owner === me) slot.owner = `retired:${me}`
record.slots.default = { owner: me }
record.active = 'default'
localStorage.thunderbolt_local_data = JSON.stringify(record)
location.reload()
```

### Devices Watcher

The listener also watches the current device's synced row via `useQuery` over `getDevice(deviceId)` (`src/hooks/use-powersync-credentials-invalid-listener.ts`):

- **`revokedAt` set**: reset to `/device-revoked`, exactly as the 403 does. The row survives the revocation because it also rides the ungated `device_self` bucket.
- **Row missing**: reset, but only if the row was already seen this session (`hadDeviceOnceRef`). On a cold start the devices table may not have synced yet, and treating that as "account deleted" would clear storage and sign the user out after an ordinary refresh.

The watcher acts only while the local data status is `ready`, which for a signed-in user means the open slot is that account's. An account switch removes the previous owner's device id, and the next render mints a new one with no row. During the switch, or on the "Couldn't switch accounts" screen after it fails, that missing row would otherwise read as a deleted account and wipe every account's data.

### Settings > Devices Page

`src/settings/devices.tsx` renders two lists from live PowerSync queries (`useQuery` from `@powersync/tanstack-react-query`, `:278-285`). No mutation invalidates a query key: the queries re-run on table change, so the lists settle once the write syncs back.

- **Pending approvals**: untrusted, non-revoked, `approval_pending` devices whose `device_type` is `normal` or unset (`src/dal/devices.ts:43-56`). Approve re-wraps the Content Key to the pending device's public keys and stores the envelope (`src/services/encryption.ts:162-192`, `src/hooks/use-approve-device.ts:14-26`); Deny clears `approval_pending` without revoking, so the device can ask again (`src/hooks/use-deny-device.ts:15-21`).
- **Trusted devices**: a revoked row lingers 24 hours so the revocation is visible, then drops off; untrusted rows are never listed here (`:53-54`, `:288-293`).
- **Revoke** shows on other, non-revoked devices; **Remove** only on a revoked bridge, matching the backend's constraint (`:197-221`, `src/hooks/use-remove-device.ts:12-18`).
- **Pairing identity**: on `bridge` devices and those whose `device_type` is `normal` or unset, the row shows `node_id`, a dialog to set or update it, and a QR code carrying `encodePairingTicket({ nodeId, name })` (`:225-267`).
