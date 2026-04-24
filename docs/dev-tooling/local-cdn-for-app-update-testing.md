# Testing In-App Updates with a Local CDN

The Tauri updater downloads from CrabNebula CDN in production. To test the full update flow locally (download, install, relaunch), you can run a local server that mimics the CDN.

## Prerequisites

- Two copies of the repo: the **old version** (simulates what the user has installed) and the **new version** (simulates what they're updating to)
- A signing keypair for update bundles

## 1. Generate a Test Signing Keypair

```bash
bun tauri signer generate -w ~/.tauri/test-update.key
# Press Enter twice for empty password
```

This creates `~/.tauri/test-update.key` (private) and `~/.tauri/test-update.key.pub` (public).

## 2. Configure the Old Build to Use Localhost

In the old build's `src-tauri/tauri.conf.json`, point the updater at your local server:

```json
"updater": {
  "endpoints": [
    "http://localhost:8888/update/{{target}}-{{arch}}/{{current_version}}"
  ],
  "pubkey": "<contents of ~/.tauri/test-update.key.pub>"
}
```

## 3. Build the New Version with Test Signing

From your current repo (the version you want to update *to*):

```bash
TAURI_PRIVATE_KEY="$(cat ~/.tauri/test-update.key)" TAURI_PRIVATE_KEY_PASSWORD="" bun tauri build
```

If the build doesn't generate a `.sig` file alongside the bundle, sign it manually:

```bash
TAURI_PRIVATE_KEY_PASSWORD="" bun tauri signer sign -f ~/.tauri/test-update.key \
  src-tauri/target/release/bundle/macos/Thunderbolt.app.tar.gz
```

## 4. Build the Old Version

From the old repo checkout:

```bash
bun tauri build --debug
```

## 5. Start the Local Update Server

```bash
bun run scripts/local-update-server.ts
```

This serves on port 8888. When the old build's updater checks for updates, the server:
- Reads the new version from `src-tauri/tauri.conf.json`
- Returns a 204 (no update) if versions match, or an update manifest pointing at the local bundle
- Serves the `.tar.gz` bundle and its signature when the updater downloads it

## 6. Run the Old Build and Trigger the Update

```bash
open path/to/old-build/src-tauri/target/debug/bundle/macos/Thunderbolt.app
```

Don't drag it to `/Applications` — run it directly from the build output. Log in, wait for the update notification, click Download, then Restart.

## Troubleshooting

- **No bundles found**: Make sure step 3 completed and `src-tauri/target/release/bundle/macos/` contains a `.tar.gz` file
- **Signature mismatch**: The pubkey in the old build's `tauri.conf.json` must match the private key used to sign the new build
- **No update offered (204)**: The version in the new build's `tauri.conf.json` must be higher than the old build's version
- **Server not reachable**: Check that nothing else is using port 8888
