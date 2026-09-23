# Devices and Accounts

Each install of Thunderbolt is a device on someone's account.

> **Preview.** Cross-device sync and end-to-end encryption are in preview and have not completed a security audit.

## Who does what

Device management is self-service: each person manages the devices on their own account under **Settings → Devices**.

| Task                                                    | Who can do it                                                                                   |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Approve, deny, or revoke a device                       | The account owner, from another device on the same account that is already trusted              |
| Delete an account and its server-side data              | The account owner, from **Settings → Preferences → Data**                                       |
| Turn end-to-end encryption on or off for the deployment | The operator, with `E2EE_ENABLED` ([configuration reference](../self-hosting/configuration.md)) |

There is no server-side admin console for browsing or revoking other people's devices. If an employee leaves and you need their access cut off, disable or delete the account in your identity provider, which stops new sign-ins. Existing sessions on devices already signed in are not ended by that alone.

## What counts as a device

A device is one install signed in to the account, identified by an ID stored locally on it.

- Every tab of the same browser profile is one device. A different browser, or a different profile in the same browser, is a separate device.
- Device names are generated, for example "Thunderbolt on macOS" or "Chrome on Windows". They cannot be renamed.
- Headless bridges for external agents appear in the list labeled **Bridge**. Command line installs appear labeled **CLI**, but only where the operator has set `CLI_DEVICE_REGISTRATION_ENABLED=true`; it is off by default, and until it is on a command line sign-in is a session with no entry in this list.
- An account can hold **10 active devices**. Devices waiting for approval and revoked devices do not count, so a device can register past the limit and then fail at approval. To free a slot, revoke one.

The list shows a last seen time for each device. A time that has stopped moving means that device has not reconnected, so any changes it made offline are still on it.

## Adding a device

Sign in on the new device with the same account, then open **Settings → Preferences → Data** and turn on **Sync This Device With Cloud**.

| Encryption | Result                                                                                                          |
| ---------- | --------------------------------------------------------------------------------------------------------------- |
| Off        | The device starts syncing right away. The app warns first that synced data is stored on the server unencrypted. |
| On         | The device registers as pending and waits. It cannot read synced data until it is approved.                     |

Anonymous sessions cannot sync. The person has to sign in to a real account first.

## Approving a device (encryption on)

A pending device shows an "Approve this device" screen and polls for the result, so nothing has to be re-entered once you approve it. There are two ways to clear it:

- **Approve from a trusted device.** Open **Settings → Devices** on a device already on the account, find the entry under **Pending approvals**, and choose **Approve**. The trusted device hands the new one a copy of the account's encryption key, wrapped so that only the new device can open it.
- **Use the recovery key.** On the pending device, choose **Use my recovery key** and enter the 24 word phrase saved at first setup. This is the path when no other device is available.

**Deny** dismisses the request without revoking anything. That device can ask again. A pending device can also withdraw its own request.

The approving device has to be a regular app device that is trusted and not revoked. A CLI device cannot approve, and neither can a device that is itself still pending.

## The recovery key

At first setup on an account, Thunderbolt generates one encryption key for the account and shows a 24 word recovery phrase that encodes it.

- It is shown **once**. There is no way to view it again later.
- It is the only way back in if every device on the account is lost or wiped.
- Without it and without a trusted device, synced data is not recoverable. The server holds only ciphertext, and nobody operating the deployment can decrypt it.

With encryption off there is no recovery key, because the server can read the synced data and any newly signed-in device gets it directly.

## Revoking a device

Use this when a device is lost or stolen, or when someone should no longer have access. On a trusted device, open **Settings → Devices**, find the entry under **Trusted devices**, and choose **Revoke**. Revocation is immediate and cannot be undone.

### What revoking does

| Effect                 | Detail                                                                                                     |
| ---------------------- | ---------------------------------------------------------------------------------------------------------- |
| Sessions ended         | The device's sign-in sessions on the server are revoked                                                    |
| Sync stopped           | The server refuses the device's sync requests from that point on                                           |
| Decryption key removed | The server-side copy of the account key wrapped for that device is deleted, so it can never fetch it again |
| Peer connections cut   | Its pairing identity is cleared, so other devices on the account stop accepting direct connections from it |
| Visible for 24 hours   | The entry stays in the list marked **Revoked**, then drops off                                             |

### What revoking does not do

**Revoking is not a remote wipe.** Data already stored on that device stays there.

If the device comes back online it shows a notice it cannot dismiss, offering to keep or delete the local copy, and either choice signs it out. The person holding the device makes that choice, so for a stolen device assume the local copy is still readable. Local data is stored unencrypted on the device itself; end-to-end encryption protects data in transit to and on the server, not the disk. Rely on full-disk encryption and the device's own lock screen for that.

If the device never reconnects, it stops syncing and keeps what it had.

### Bringing a revoked device back

Sign in again on that device and approve it as new. It will appear as a fresh entry in the pending queue, because the revoked record can never be reactivated.

For a revoked **Bridge** entry only, a **Remove** button appears. That deletes the record, which is required before the same bridge hardware can be paired again.

### Revoking a CLI device

Where CLI registration is enabled, a command line install is revoked from the same list. It loses its session, and the person has to run the sign-in command again and approve the new code in the app. Personal access tokens are separate: they are not devices, do not appear in this list, and revoking a device does not revoke them.

## Signing out, revoking, and deleting: which to use

| Action             | Server-side effect                                          | Local data on the device                       | Other devices                  |
| ------------------ | ----------------------------------------------------------- | ---------------------------------------------- | ------------------------------ |
| **Sign out**       | Ends that session                                           | Kept or deleted, the user chooses              | Unaffected                     |
| **Revoke**         | Sessions ended, sync and decryption blocked for that device | Kept or deleted, the person holding it chooses | Unaffected                     |
| **Delete account** | Account and all synced data removed                         | Deleted on every device that reconnects        | All of them reset and sign out |

The log out prompt offers **Leave data on device** or **Delete data from device**; the account and everything synced to it are untouched either way, and signing back in pulls the synced data down again.

Signing out also clears the device's encryption keys, so the next sign-in on that device is treated as a new device and needs approval again when encryption is on.

A separate **Delete All Local Data** control appears under **Settings → Preferences → Data** only when nobody has signed in yet, for someone trying the app without an account. It wipes that device's local database and nothing else.

## Deleting an account

Open **Settings → Preferences → Data** and choose **Delete My Account**.

There is no grace period and no undo. Export first from the same screen if the data matters: **Export Your Data** writes a JSON file of chats, tasks, prompts, skills, projects, automations, the model, agent and server entries the person added, and settings.

Two things about that file: attached file contents are not in it, and it does include the credentials stored on that device such as model API keys.

### What is removed

- The account and every synced record attached to it on the server: chats and messages, tasks, prompts, skills, automations, projects, model entries, settings, and the device list.
- All sessions on the account.
- The local database on the device that ran the deletion.
- The local database on every other signed-in device, the next time it reaches the server. Those devices redirect to an "account deleted" screen.

### What is not removed

| Not removed                                            | Why                                                    |
| ------------------------------------------------------ | ------------------------------------------------------ |
| Local data on a device that never reconnects           | Nothing can reach it. Wipe it by hand                  |
| Prompts and responses already sent to a model provider | Retention is that provider's policy, not Thunderbolt's |
| Data written into a connected tool or external server  | It lives in that system, not in Thunderbolt            |
| Exports already downloaded                             | Ordinary files on disk                                 |
| Server logs and, if enabled, analytics                 | Handled by the operator's retention policy             |

Deleting the account in Thunderbolt does not delete the user in your identity provider. Signing up again with the same email creates a new, empty account.

## Related pages

- [Apps and Sync](../using/apps-and-sync.md) covers what syncs, what stays local, and offline behavior.
- [Configuration reference](../self-hosting/configuration.md) covers `E2EE_ENABLED` and the other deployment settings.
