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

The updater config lives under `plugins.updater` in `src-tauri/tauri.conf.json`, where it normally points at the CrabNebula CDN. In the old build's checkout, replace those two values in place. Don't add a second block alongside it: Tauri's config struct is deserialized with `deny_unknown_fields`, so a top-level `"updater"` key aborts every `tauri` command with `Additional properties are not allowed ('updater' was unexpected)`.

```json
"plugins": {
  "updater": {
    "endpoints": [
      "http://localhost:8888/update/{{target}}-{{arch}}/{{current_version}}"
    ],
    "pubkey": "<contents of ~/.tauri/test-update.key.pub>"
  }
}
```

## 3. Build the New Version with Test Signing

From your current repo (the version you want to update _to_):

```bash
TAURI_SIGNING_PRIVATE_KEY="$(cat ~/.tauri/test-update.key)" TAURI_SIGNING_PRIVATE_KEY_PASSWORD="" bun tauri build
```

The variable names matter: Tauri v2 reads `TAURI_SIGNING_PRIVATE_KEY` / `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`, and `bundle.createUpdaterArtifacts` is `true` in `src-tauri/tauri.conf.json`, so a build with no key fails at the bundling step rather than emitting an unsigned artifact — which is why `.github/workflows/test-build.yml` overrides that flag to `false` for builds that never reach the updater. The same two variables drive real releases in `.github/workflows/desktop-release.yml` — see [Tauri Signing Keys](../features/tauri-signing-keys.md).

To sign an existing bundle without rebuilding:

```bash
TAURI_SIGNING_PRIVATE_KEY_PASSWORD="" bun tauri signer sign -f ~/.tauri/test-update.key \
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
- **Signature mismatch**: `plugins.updater.pubkey` in the old build's `tauri.conf.json` must match the private key used to sign the new build
- **No update offered (204)**: The version in the new build's `tauri.conf.json` must be higher than the old build's version
- **Server not reachable**: Check that nothing else is using port 8888
