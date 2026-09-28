# Testing In-App Updates with a Local CDN

In production the Tauri updater downloads from CrabNebula CDN. `scripts/local-update-server.ts` mimics it locally, so you can test download, install, and relaunch.

## Prerequisites

- Two repo checkouts: **old** (the installed version) and **new** (the update target)
- A signing keypair for update bundles

## 1. Generate a Test Signing Keypair

```bash
bun tauri signer generate -w ~/.tauri/test-update.key
# Press Enter twice for empty password
# Writes test-update.key (private) and test-update.key.pub (public)
```

## 2. Point the Old Build at Localhost

Edit `plugins.updater` in the old checkout's `src-tauri/tauri.conf.json` in place. The config struct uses `deny_unknown_fields`, so a second, top-level `"updater"` key aborts every `tauri` command with `Additional properties are not allowed ('updater' was unexpected)`.

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

From the checkout you want to update _to_:

```bash
TAURI_SIGNING_PRIVATE_KEY="$(cat ~/.tauri/test-update.key)" TAURI_SIGNING_PRIVATE_KEY_PASSWORD="" bun tauri build
```

- Tauri v2 requires exactly those variable names; real releases pass the same two (`.github/workflows/desktop-release.yml`, [Tauri Signing Keys](../tauri-signing-keys.md)).
- `bundle.createUpdaterArtifacts` is `true` in `src-tauri/tauri.conf.json`, so a keyless build fails at bundling instead of emitting an unsigned artifact; `.github/workflows/test-build.yml` sets it `false` where the updater is irrelevant.

Sign an existing bundle without rebuilding:

```bash
TAURI_SIGNING_PRIVATE_KEY_PASSWORD="" bun tauri signer sign -f ~/.tauri/test-update.key \
  src-tauri/target/release/bundle/macos/Thunderbolt.app.tar.gz
```

## 4. Build the Old Version

From the old checkout:

```bash
bun tauri build --debug
```

## 5. Start the Local Update Server

```bash
bun run scripts/local-update-server.ts
```

The server listens on port 8888. On each update check it:

- Reads the new version from `src-tauri/tauri.conf.json`
- Returns 204 if versions match, otherwise a manifest pointing at the local bundle
- Serves the `.tar.gz` bundle and its signature on download

## 6. Run the Old Build and Trigger the Update

```bash
open path/to/old-build/src-tauri/target/debug/bundle/macos/Thunderbolt.app
```

Run it from the build output, not `/Applications`. Log in, wait for the update prompt, click Download, then Restart.

## Troubleshooting

- **No bundles found**: step 3 left no `.tar.gz` in `src-tauri/target/release/bundle/macos/`
- **Signature mismatch**: the old build's `plugins.updater.pubkey` is not the key that signed the new build
- **No update offered (204)**: the new build's `tauri.conf.json` version is not higher than the old build's
- **Server not reachable**: something else is on port 8888
