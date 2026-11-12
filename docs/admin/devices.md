# Devices and Accounts

Each install of Thunderbolt is a device on someone's account.

## Who does what

Device management is self-service. Each person manages the devices on their own account under **Settings → Devices**, approving, denying, or revoking from another device on the same account that is already trusted. The account owner can also delete the account and its server-side data, from **Settings → Preferences → Data**.

There is no server-side admin console for browsing or revoking other people's devices. If an employee leaves and you need their access cut off, disable or delete the account in your identity provider. That stops new sign-ins; it does not by itself end existing sessions on devices already signed in.

## What counts as a device

A device is one install signed in to the account, identified by an ID stored locally on it. The list shows a last seen time for each. A time that has stopped moving means the device has not reconnected, so any changes it made offline are still on it.

- Every tab of the same browser profile is one device. A different browser, or a different profile in the same browser, is a separate device.
- Device names are generated, for example "Thunderbolt on macOS" or "Chrome on Windows". They cannot be renamed.
- Headless bridges for external agents appear in the list labeled **Bridge**. Command line installs appear labeled **CLI**, but only where the operator has set `CLI_DEVICE_REGISTRATION_ENABLED=true`; it is off by default, and until it is on a command line sign-in is a session with no entry in this list.
- An account can hold **10 active devices**. Devices waiting for approval and revoked devices do not count, so more devices can queue for approval than there are free slots; the extras are refused at approval rather than at registration. To free a slot, revoke one.

## Adding a device

Sign in on the new device with the same account. If the setup wizard does not open on its own, open **Settings → Preferences → Data** and turn on **Sync This Device With Cloud**. The device registers as pending, unable to read synced data until it is approved. The person has to be signed in to a real account first, because anonymous sessions cannot sync.

## Approving a device

A pending device shows an "Approve this device" screen and polls for the result. Once a trusted device starts the approval, the screen shows a 2-digit approval code. Choose one of the available ways to unlock it:

- **Approve from a trusted device.** Open **Settings → Devices** on a device already on the account, find the entry under **Pending approvals**, and choose **Approve**, then tap the code that the new device shows among the six offered. If none match, choose **None of these match**; nothing is approved and there is no override. To retry, choose **New code** on the new device. **Use fingerprint instead** on both screens switches to typing the full fingerprint. The trusted device then wraps the account's encryption key to the verified device keys.
- **Code limits.** Each trusted device allows three unsuccessful code attempts per 24 hours; after that it offers only the fingerprint until the window passes. A device running an older version shows only the fingerprint, and so does every device when the backend predates approval codes.
- **Use the recovery key.** On the pending device, choose **Use my recovery key** and enter the current recovery phrase. This is the path when no other device is available.
- **Use an available passkey.** If the account has an enrolled passkey that can unlock sync, choose **Unlock with passkey** on the pending device.

**Deny** dismisses the request without revoking anything, and that device can ask again; a pending device can also withdraw its own request. The approving device has to be trusted and not revoked, and cannot be a CLI device or a device that is itself still pending. Revoking is stricter: only a regular app device can do that.

### After a legacy encryption upgrade

Among regular app devices, only the device running the upgrade stays trusted. Save the new recovery phrase it shows; the previous phrase stops working. Other trusted app devices return to pending approval; existing pending or denied requests keep their state. They can unlock through verified approval, the new recovery phrase or a passkey enrolled for sync. CLI and bridge entries are unchanged. Existing encrypted data is preserved.

### Approval limits

Code and fingerprint verification require trusted code on both the approving device and the new device. A web host can modify the approving device's checks or the new device's displayed code, fingerprint and keys. A person who taps a code without comparing it picks the right one one time in six, so tell people to compare before tapping and to choose **Deny** for a request they did not start. Independently distributed desktop/mobile builds provide the stronger boundary. Older approvers lack the check. A pending client from a release before fingerprint approval shows no fingerprint. Update it before approving it from an updated device. The current recovery phrase or a passkey enrolled for sync remains an alternative where the client supports that unlock method. On an honest deployment, `MIN_APP_VERSION` can require headers declaring the release introducing fingerprint approval or later on every gated API request; a malicious server can ignore that policy. These checks protect future approvals and do not repair an account key exposed by a past approval.

## The recovery key

At first setup on an account, Thunderbolt generates the account's encryption keys and shows a 24 word recovery phrase that can unlock them. Sync starts once the person confirms they saved it. The phrase is shown **once**; there is no way to view it again later. Keep it safe so you can unlock sync if every trusted device is lost or wiped.

To replace a lost or exposed phrase, choose **Change Recovery Phrase** under **Settings → Preferences → Data** on a trusted device and enter the code emailed to the account. The old phrase stops working.

> Without a recovery phrase, a trusted device or an available passkey that unlocks sync, the app cannot recover synced message content. The server holds ciphertext for that content; ids, timestamps, relationships and device names stay readable. See [Security and privacy](security-and-privacy.md) for the full list.

### Organizational key escrow

On a deployment with [organizational key escrow](../self-hosting/configuration.md#organizational-key-escrow) enabled, an operator holding its private key can decrypt an account's data offline.

## Revoking a device

Use this when a device is lost or stolen, or when someone should no longer have access. On a trusted device, open **Settings → Devices**, find the entry under **Trusted devices**, and choose **Revoke**. Revocation cannot be undone.

### What revoking does

Uploads and sync-token renewal are refused at once, and the device's sign-in sessions are deleted. Downstream sync stops as soon as the revocation reaches the sync service, without waiting for the device's current sync token to expire.

- The revoking device replaces the account key and the key used for new writes, and hands the new account key only to the devices that remain. The revoked device cannot read anything written afterwards, and the recovery phrase keeps working. If that step fails, every trusted device shows **Finish securing** on the revoked entry until someone completes it.
- Its pairing identity is cleared, so other devices on the account stop accepting direct connections from it.
- The entry stays in the list marked **Revoked** for 24 hours, then drops off.

### What revoking does not do

Personal access tokens are unaffected by any revocation. They are not tied to a device, so they keep working until they expire or the user deletes them.

The device signs out and clears its local copy on its own the next time it connects. A device that never comes back online is never reached and keeps what it has. Local data is stored unencrypted on the device itself; end-to-end encryption protects data in transit to and on the server, not the disk. Use full-disk encryption and the device's own lock screen for that.

> Revoking is not a remote wipe. A device that never comes back online keeps its data, so for a stolen device assume the local copy is still readable.

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
| **Revoke**         | Sessions ended, sync and decryption blocked for that device | Cleared the next time it connects; kept on a device that never comes back online                              | Unaffected           |
| **Delete account** | Account and all synced data removed                         | Deleted on devices with sync on that reconnect while their token is live; others sign out and keep their copy | All of them sign out |

The log out prompt offers **Leave data on device** or **Delete data from device**; the account and everything synced to it are untouched either way, and signing back in pulls the synced data down again once the device is approved. Signing out does not revoke the device on the server, so its entry stays in the trusted list and holds one of the ten slots until someone revokes it. Signing out also clears the device's encryption keys, so the next sign-in on that device is treated as a new device and needs approval again.

Data left on the device stays with the account that left it. When a different account signs in on the same browser profile or app, the app reloads into that account's own local data. The new account never sees the first account's chats, attached files, saved connection credentials, voice key or unsent changes. All of it is back when the first account signs in again. The switch removes the first account's encryption keys from the device, even when that account never logged out (for example, its session expired and someone else signed in at the sign-in prompt). So when the first account returns, the device needs approval again before it can read that account's synced data (see [Approving a device](#approving-a-device)). An account with no other trusted device, no recovery phrase and no passkey enrolled for sync can't unlock its encrypted synced data again. A full local wipe (**Delete data from device**, **Delete All Local Data**, or the reset that follows a revoked device or a deleted account) removes the local data of every account on the device. Data left by an account that signed out before this behavior shipped can't be tied to that account, so the app no longer opens it. Its synced data comes back on sign-in, and the developer notes describe how to recover the rest by hand.

A separate **Delete All Local Data** control appears under **Settings → Preferences → Data** in an anonymous session, so only on deployments that allow anonymous access. It wipes that device's local data: the database, attachments and browser storage.

Local data from an anonymous session, its chats included, does not carry over to the next anonymous session. When an anonymous session expires, the app starts a new one with no local data, and deletes the expired session's local data on a later start.

## Deleting an account

Open **Settings → Preferences → Data** and choose **Delete My Account**. **Export Your Data**, on the same screen, writes a JSON file of chats, tasks, prompts, skills, projects, automations, the model, agent and server entries the person added, and settings. Attached file contents are not in it. The credentials stored on that device are, including model API keys.

> There is no grace period and no undo. Export first if the data matters.

### What is removed

- The account and every synced record attached to it on the server: chats and messages, tasks, prompts, skills, automations, projects, model entries, settings, and the device list.
- All sessions on the account.
- The local database on the device that ran the deletion.
- The local database on every other device that has sync on, the next time it reaches the server while its token is still valid. Those devices redirect to an "account deleted" screen.

### What is not removed

| Not removed                                                        | Why                                                                                              |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| Local data on a device that never reconnects, or one with sync off | It learns the account is gone by losing its session, not by syncing the removal. Wipe it by hand |
| Rate-limit and sign-in-code rows                                   | No link to the account record                                                                    |
| Prompts and responses already sent to a model provider             | Retention is that provider's policy, not Thunderbolt's                                           |
| Data written into a connected tool or external server              | It lives in that system, not in Thunderbolt                                                      |
| Exports already downloaded                                         | Ordinary files on disk                                                                           |
| Server logs and, if enabled, analytics                             | Handled by the operator's retention policy                                                       |

Deleting the account in Thunderbolt does not delete the user in your identity provider. Signing up again with the same email creates a new, empty account.

## Related pages

- [Apps and Sync](../using/apps-and-sync.md) covers what syncs, what stays local, and offline behavior.
- [Configuration reference](../self-hosting/configuration.md) covers `POWERSYNC_TOKEN_EXPIRY_SECONDS`, `CLI_DEVICE_REGISTRATION_ENABLED` and the other deployment settings.
