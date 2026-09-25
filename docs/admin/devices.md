# Devices and Accounts

Each install of Thunderbolt is a device on someone's account.

> **Preview.** Cross-device sync and end-to-end encryption are in preview and have not completed a security audit.

## Who does what

Device management is self-service. Each person manages the devices on their own account under **Settings → Devices**, approving, denying, or revoking from another device on the same account that is already trusted. The account owner can also delete the account and its server-side data, from **Settings → Preferences → Data**. Turning end-to-end encryption on or off for the deployment belongs to the operator, who sets `E2EE_ENABLED` (see the [configuration reference](../self-hosting/configuration.md)).

There is no server-side admin console for browsing or revoking other people's devices. If an employee leaves and you need their access cut off, disable or delete the account in your identity provider. That stops new sign-ins; it does not by itself end existing sessions on devices already signed in.

## What counts as a device

A device is one install signed in to the account, identified by an ID stored locally on it. The list shows a last seen time for each. A time that has stopped moving means the device has not reconnected, so any changes it made offline are still on it.

- Every tab of the same browser profile is one device. A different browser, or a different profile in the same browser, is a separate device.
- Device names are generated, for example "Thunderbolt on macOS" or "Chrome on Windows". They cannot be renamed.
- Headless bridges for external agents appear in the list labeled **Bridge**. Command line installs appear labeled **CLI**, but only where the operator has set `CLI_DEVICE_REGISTRATION_ENABLED=true`; it is off by default, and until it is on a command line sign-in is a session with no entry in this list.
- An account can hold **10 active devices**. Devices waiting for approval and revoked devices do not count, so more devices can queue for approval than there are free slots; the extras are refused at approval rather than at registration. To free a slot, revoke one.

## Adding a device

Sign in on the new device with the same account, then open **Settings → Preferences → Data** and turn on **Sync This Device With Cloud**. With encryption off the device starts syncing right away, with no confirmation step. Turn encryption on and it registers as pending instead, unable to read synced data until it is approved. Either way the person has to be signed in to a real account first, because anonymous sessions cannot sync.

## Approving a device (encryption on)

A pending device shows an "Approve this device" screen and polls for the result, so nothing has to be re-entered once you approve it. There are two ways to clear it:

- **Approve from a trusted device.** Open **Settings → Devices** on a device already on the account, find the entry under **Pending approvals**, and choose **Approve**. The trusted device hands the new one a copy of the account's encryption key, wrapped so that only the new device can open it.
- **Use the recovery key.** On the pending device, choose **Use my recovery key** and enter the 24 word phrase saved at first setup. This is the path when no other device is available.

**Deny** dismisses the request without revoking anything, and that device can ask again; a pending device can also withdraw its own request. The approving device has to be trusted and not revoked, and cannot be a CLI device or a device that is itself still pending. Revoking is stricter: only a regular app device can do that.

## The recovery key

At first setup on an account, Thunderbolt generates one encryption key for the account and shows a 24 word recovery phrase that encodes it. The phrase is shown **once**; there is no way to view it again later. It is the only way back in if every device on the account is lost or wiped.

> Without it and without a trusted device, synced message content is not recoverable. The server holds ciphertext for that content; ids, timestamps, relationships and device names stay readable. See [Security and privacy](security-and-privacy.md) for the full list.

With encryption off there is no recovery key, because the server can read the synced data and any newly signed-in device gets it directly.

## Revoking a device

Use this when a device is lost or stolen, or when someone should no longer have access. On a trusted device, open **Settings → Devices**, find the entry under **Trusted devices**, and choose **Revoke**. Revocation cannot be undone.

### What revoking does

Uploads and sync-token renewal are refused at once. Downstream sync stops when the device's current sync token expires, within `POWERSYNC_TOKEN_EXPIRY_SECONDS` (one hour by default); rotate `POWERSYNC_JWT_SECRET` to cut it off sooner.

With encryption on, the device's sign-in sessions are deleted too. With encryption off the session was never bound to a device, so it survives revocation: the device stops syncing but can still reach other API routes until that session expires.

- The server-side copy of the account key wrapped for that device is deleted, so it can never fetch the key again.
- Its pairing identity is cleared, so other devices on the account stop accepting direct connections from it.
- The entry stays in the list marked **Revoked** for 24 hours, then drops off.

### What revoking does not do

Personal access tokens are unaffected by any revocation. They are not tied to a device, so they keep working until they expire or the user deletes them.

If the device comes back online it shows a notice it cannot dismiss, offering to keep or delete the local copy, and either choice signs it out. The person holding the device makes that choice. Local data is stored unencrypted on the device itself; end-to-end encryption protects data in transit to and on the server, not the disk. Use full-disk encryption and the device's own lock screen for that.

> Revoking is not a remote wipe. Data already on that device stays there, so for a stolen device assume the local copy is still readable.

If the device never reconnects, it stops syncing and keeps what it had.

### Bringing a revoked device back

Sign in again on that device and approve it as new. It will appear as a fresh entry in the pending queue, because the revoked record can never be reactivated.

For a revoked **Bridge** entry only, a **Remove** button appears. That deletes the record, which is required before the same bridge hardware can be paired again.

### Revoking a CLI device

Where CLI registration is enabled, a command line install is revoked from the same list. It loses its session, and the person has to run the sign-in command again and approve the new code in the app. Personal access tokens are separate: they are not devices and do not appear in this list.

## Signing out, revoking, and deleting: which to use

| Action             | Server-side effect                                          | Local data on the device                                                                                      | Other devices        |
| ------------------ | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | -------------------- |
| **Sign out**       | Ends that session                                           | Kept or deleted, the user chooses                                                                             | Unaffected           |
| **Revoke**         | Sessions ended, sync and decryption blocked for that device | Kept or deleted, the person holding it chooses                                                                | Unaffected           |
| **Delete account** | Account and all synced data removed                         | Deleted on devices with sync on that reconnect while their token is live; others sign out and keep their copy | All of them sign out |

The log out prompt offers **Leave data on device** or **Delete data from device**; the account and everything synced to it are untouched either way, and signing back in pulls the synced data down again. Signing out does not revoke the device on the server, so its entry stays in the trusted list and holds one of the ten slots until someone revokes it. Signing out also clears the device's encryption keys, so the next sign-in on that device is treated as a new device and needs approval again when encryption is on.

A separate **Delete All Local Data** control appears under **Settings → Preferences → Data** in an anonymous session, so only on deployments that allow anonymous access. It wipes that device's local database and nothing else.

## Deleting an account

Open **Settings → Preferences → Data** and choose **Delete My Account**. **Export Your Data**, on the same screen, writes a JSON file of chats, tasks, prompts, skills, projects, automations, the model, agent and server entries the person added, and settings. Attached file contents are not in it. The credentials stored on that device are, including model API keys.

> There is no grace period and no undo. Export first if the data matters.

### What is removed

- The account and every synced record attached to it on the server: chats and messages, tasks, prompts, skills, automations, projects, model entries, settings, and the device list.
- All sessions on the account.
- The local database on the device that ran the deletion.
- The local database on every other device that has sync on, the next time it reaches the server while its token is still valid. Those devices redirect to an "account deleted" screen.

### What is not removed

| Not removed                                                        | Why                                                                                               |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| Local data on a device that never reconnects, or one with sync off | It learns the account is gone by losing its session, not by syncing the removal. Wipe it by hand  |
| The waitlist row, and rate-limit and sign-in-code rows             | No link to the account record. The address stays approved, so signing up again skips the waitlist |
| Prompts and responses already sent to a model provider             | Retention is that provider's policy, not Thunderbolt's                                            |
| Data written into a connected tool or external server              | It lives in that system, not in Thunderbolt                                                       |
| Exports already downloaded                                         | Ordinary files on disk                                                                            |
| Server logs and, if enabled, analytics                             | Handled by the operator's retention policy                                                        |

Deleting the account in Thunderbolt does not delete the user in your identity provider. Signing up again with the same email creates a new, empty account.

## Related pages

- [Apps and Sync](../using/apps-and-sync.md) covers what syncs, what stays local, and offline behavior.
- [Configuration reference](../self-hosting/configuration.md) covers `E2EE_ENABLED` and the other deployment settings.
