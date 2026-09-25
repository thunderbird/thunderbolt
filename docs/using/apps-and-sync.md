# Apps and Sync

Each install keeps its own copy of your data and works on its own. Sync is optional, and you control it per device.

> **Preview.** Cross-device sync is in preview, and the optional end-to-end encryption that protects synced data has not yet had a cryptography audit.

## Where Thunderbolt runs

| Platform              | How you get it                                                                         | Notes                                                                          |
| --------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Web                   | Open the app URL in Chrome, Edge, Firefox, or Safari                                   | Current browser versions, served over HTTPS                                    |
| macOS, Windows, Linux | Installers on the [releases page](https://github.com/thunderbird/thunderbolt/releases) | Checks for updates and prompts to restart when one is ready                    |
| iOS, Android          | Apple TestFlight and Google Play internal testing                                      | Not yet listed publicly in the app stores                                      |
| Terminal              | `thunderbolt` command line client                                                      | Apple Silicon Macs and Linux. Installable from the desktop app, or from source |

The web, desktop and mobile apps share one codebase, so features carry across except where a platform blocks them: the in-app browser and the cloud-proxy switch are desktop-only. The terminal client is a separate coding agent rather than this app.

The web app requires HTTPS. It keeps a database inside the browser and uses browser cryptography, both of which browsers only allow on a secure origin. Automatic desktop updates reach only the official builds, which ship with an update feed and a signing key. A desktop app you build yourself has neither, so you distribute new installers to your users the same way you distributed the first one.

### Pointing the apps at your own backend

The server address is fixed when a client is built, and there is no field inside the app for it.

- **Self-hosted web**: build the web client with `VITE_THUNDERBOLT_CLOUD_URL` set to your backend, then serve it. See the [configuration reference](../self-hosting/configuration.md).
- **Desktop and mobile**: the published builds point at the public service. To hand your team desktop or mobile apps that talk to your own backend, build and distribute them yourself.

## Data lives on the device first

Every install holds a full local database. Reads and writes go there first, so the interface does not wait on the network. If sync is off, that local copy is the only copy, and chat content leaves the device only when it is sent to a model or to a tool you have connected.

## Turning sync on and off

Sync is a per-device switch under **Settings → Preferences → Data**, labeled **Sync This Device With Cloud**, and repeated as **Cloud Sync** in the sidebar account menu. A device that has never been signed in has sync off, and anonymous sessions cannot sync at all. Signing in from inside the app turns sync on for that device; where the deployment has end-to-end encryption enabled, a short setup step runs first, and sync turns on when it finishes. You can turn it back off from the same screen at any time. That leaves the local database intact and stops the device exchanging changes.

Whether the data is encrypted on the server is the operator's decision, and a user cannot change it. With encryption off, synced data is stored on the server in a form the server can read, and every device the account signs in on syncs immediately. With encryption on, each new device has to be approved before it can read anything.

Encryption covers the columns that hold your content. Structural fields, and the external agents you add, are stored readable either way.

## What syncs and what does not

These sync across your devices:

- Chats and messages
- Tasks and skills
- Projects and their instructions
- Model entries and per-model tuning
- External agent entries
- Settings and preferences
- The list of devices on the account

These stay on the one device:

- Model API keys
- Tokens for connected accounts such as Google and Microsoft
- MCP server addresses and their credentials
- External agent credentials
- Attached file contents
- The local search index and sign-in token

Credentials never sync. A model or an external agent you add on one device appears on the others, but each device needs its own key or token entered locally. MCP servers do not appear at all on the other devices, because an address without its credential is one they could not connect to anyway.

File attachments do not follow a chat. The message carries the file's name but not its bytes, so on another device the message shows the filename and the model does not receive the file.

> Attached files are absent from a data export too. The only copy is on the device that added them. The export does carry your API keys and tool server credentials in the clear, so treat the file as a secret.

## Adding a device

Install or open Thunderbolt on the new device and sign in with the same account. With encryption off, the device starts syncing immediately. With encryption on, it registers as pending and shows an "Approve this device" screen until you either:

- Approve it from an already trusted device under **Settings → Devices**, or
- Enter the 24 word recovery key you saved when you first set up sync.

The pending device checks for approval on its own, so nothing needs re-entering once you approve.

Device names are generated, for example "Thunderbolt on macOS" or "Chrome on Windows", and they cannot be renamed. Every tab of the same browser profile counts as one device; a different browser, or a different profile in the same browser, is separate. Where the deployment has end-to-end encryption enabled, an account can have **10 active devices**. Devices still waiting for approval do not count toward the limit, and revoked ones do not either, so more devices can queue for approval than there are free slots; the extras are refused at approval rather than at registration. Headless bridges appear in the device list labeled **Bridge**. Command line installs appear labeled **CLI**, but only where the operator has set `CLI_DEVICE_REGISTRATION_ENABLED=true`; it is off by default, and until it is on `thunderbolt login` fails outright. A command line client authenticated with an API token never registers a device and has no entry in the list.

## Approving, denying, and revoking

**Settings → Devices** lists pending and trusted devices, with the time each was last seen.

| Action      | Where it applies          | What happens                                                                         |
| ----------- | ------------------------- | ------------------------------------------------------------------------------------ |
| **Approve** | A device pending approval | The device gains access to the account's encrypted data and starts syncing           |
| **Deny**    | A device pending approval | The request is dismissed. That device can ask again                                  |
| **Revoke**  | Any other trusted device  | Sessions on it are ended, it stops syncing, and it can no longer decrypt synced data |
| **Remove**  | A revoked bridge only     | Deletes the record so the same bridge can be paired again                            |

The device shows a notice it cannot dismiss, offering to keep or delete the data already on it, and either choice signs it out.

Revoked entries stay visible in the list for 24 hours so the change is easy to confirm, then disappear.

> Revoking is not reversible. To bring a device back, sign in again and approve it as new.

Deleting the account is separate and wider, but it does not reach every device on its own. A device with sync on that reconnects soon after clears its local data and shows an account-deleted screen. A device with sync off, or one that comes back after too long a gap, is signed out instead and keeps its local copy, so wipe those by hand. Attached files are never cleared either, as above.

Full detail on approval, recovery keys, and revocation is in [Devices and Accounts](../admin/devices.md).

## Working offline

With no network you can read and search existing chats, write messages, edit tasks, and change settings. Web search and other connected tools need the network, as do signing in, sync itself, and approving a device. So do model responses, unless the model runs on the same machine or network.

Changes made offline are saved locally and queued. On reconnect the device uploads them and pulls down what it missed. A record changed on two devices is merged column by column, and for any column both changed, the value from whichever device uploads last is kept. That is not necessarily the one edited most recently: a device that was offline for a day overwrites the newer edit when it reconnects.

The web app has to be fetched from the server before it can run, so a browser with no connection cannot open it cold. The desktop and mobile apps start offline.

Under **Settings → Devices**, a last seen time that has stopped moving means that device has not reconnected yet, and its queued changes are still on it.
