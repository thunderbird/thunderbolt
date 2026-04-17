---
title: Account & Devices
description: How account deletion and device revocation work, and what happens on the other devices.
---

Thunderbolt's account and device flows are designed to be fast, reversible where it makes sense, and irreversible where it must be. This page documents what happens when you delete your account or revoke a device — both on the server and on every other device. It mirrors [`docs/delete-account-and-revoke-device.md`](https://github.com/thunderbird/thunderbolt/blob/main/docs/delete-account-and-revoke-device.md).

## Account deletion

**From the app:** *Settings → Preferences → Delete my account* (requires confirmation).

**What the backend does.** The app calls `DELETE /v1/account`. The backend hard-deletes the user row and every related record (settings, chats, models, devices, envelopes) in one transaction. Account deletion is one of the few hard-delete paths in the codebase — per the project's soft-delete policy, hard deletes are reserved for account removal, device revocation, and PowerSync-mandated operations.

**What other devices do.** The next time any device refreshes its PowerSync token, the backend responds with `410 Gone` and `code: "ACCOUNT_DELETED"`. The app treats this as a credentials-invalid signal and runs the [reset flow](#the-reset-flow).

## The `devices` table

Every device registers itself on first run. Registration stores:

- A random device ID (persisted in `localStorage`, sent as `X-Device-ID` on every PowerSync token request)
- A human-readable name (from OS/hostname)
- Device public keys when end-to-end encryption is enabled (ECDH P-256 + ML-KEM-768)

The table is synced via PowerSync, so the list in *Settings → Devices* reflects every device you've signed in on — even from this one.

## Listing devices

*Settings → Devices* reads from the synced `devices` table. Each row shows:

- Device name, with a **This device** badge next to the current one
- Last-seen time (updated every time the device requests a PowerSync token)
- **Revoked** badge when `revoked_at` is set
- **Revoke** button on other, non-revoked devices

## Revoking a device

Revocation is how you end a session on a lost or stolen device.

1. Tap **Revoke** on another device (confirmation required). The app calls `POST /v1/account/devices/:id/revoke`.
2. The backend sets `revoked_at` on that device row. When end-to-end encryption is in use, the device's envelope (the wrapped content key) is also deleted from the `envelopes` table — once the envelope is gone, even a compromise of the device's private key cannot recover the content key.
3. PowerSync streams the updated `devices` row to every client, including the revoked one.
4. On the revoked device:
   - **Immediate:** the app subscribes to its own device row via React Query (`getDevice(deviceId)`). When it sees `revoked_at` set, it runs the reset flow.
   - **On next token refresh:** the backend returns `403 Forbidden` with `code: "DEVICE_DISCONNECTED"` — the sync connector dispatches the credentials-invalid event and the app resets.

Revocation is idempotent — revoking an already-revoked device returns `204`.

## The reset flow

Account deletion and device revocation both funnel into the same client-side reset, orchestrated by `usePowerSyncCredentialsInvalidListener`:

1. `setSyncEnabled(false)` — disconnect from PowerSync.
2. `localStorage.clear()` — drops the auth token and device ID.
3. `resetAppDir()` — wipes the app directory (SQLite DB and related files).
4. `window.location.reload()` — reload into a clean, signed-out state.

The event is triggered in two ways:

- The `powersyncCredentialsInvalid` event fires when a token request returns `410` (account deleted) or `403` with `DEVICE_DISCONNECTED` (device revoked).
- The `devices` table listener fires the moment PowerSync syncs a row with `revoked_at` set — even before the next token refresh.

## Backend response reference

| Status | Code                    | Meaning                                             | Client reaction                   |
| ------ | ----------------------- | --------------------------------------------------- | --------------------------------- |
| `410`  | `ACCOUNT_DELETED`       | User record no longer exists                        | Run reset flow                    |
| `403`  | `DEVICE_DISCONNECTED`   | This device has been revoked                        | Run reset flow                    |
| `409`  | `DEVICE_ID_TAKEN`       | Device ID collides with a different user            | Reset to generate a fresh device id |
| `400`  | `DEVICE_ID_REQUIRED`    | Upload request missing `X-Device-ID`                | Send the header and retry         |
| `401`  | —                       | Generic auth failure (expired session, bad token)   | Re-authenticate                   |

## Summary

| Action         | Where         | Backend behavior                             | Other devices                                                             |
| -------------- | ------------- | -------------------------------------------- | ------------------------------------------------------------------------- |
| Delete account | Preferences   | User and data deleted; `410` on token refresh | Reset when `410` received or when devices table reflects deletion         |
| Revoke device  | Devices       | `revoked_at` set; envelope deleted (if E2E) | Revoked device resets when it sees `revoked_at` or gets `403` on refresh |
