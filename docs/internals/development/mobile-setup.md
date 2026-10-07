# Mobile Setup

iOS and Android need native SDKs beyond `make setup`. `make doctor` checks for them and
prints the install commands.

## Quick Reference

| Command                    | Use                                                                                                                        |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `make dev-desktop`         | Desktop dev. Backend + Tauri shell. Avoids the `:1420` port collision from `make run` + `bun tauri:dev:desktop` together.  |
| `make dev-ios`             | iOS dev on the first **booted** simulator. Open Simulator.app first.                                                       |
| `make dev-android`         | Android dev. Re-inits `gen/android` for the dev identifier on every run ([details](#android-package-identifier-mismatch)). |
| `make build-desktop-local` | Local desktop release build, skipping the updater bundle (which needs `TAURI_SIGNING_PRIVATE_KEY`).                        |

## iOS

### Prerequisites

- **Xcode** 15+ with command-line tools (`xcode-select --install`).
- An **iOS Simulator runtime**: Xcode → Settings → Components.
- `make doctor` checks both.

### Running on a simulator

```bash
open -a Simulator                     # boot a simulator from your Xcode list
make dev-ios                          # targets the booted simulator by name
```

### Wi-Fi-paired iPhone gotcha

`tauri ios dev` auto-detects any **Wi-Fi-paired iPhone** and deploys to it even with the
cable unplugged; `xcodebuild` then fails with "developer disk image could not be mounted",
because the phone lacks device-development setup.

`make dev-ios` passes the booted simulator's **name** (`xcrun simctl list devices booted`,
parenthesised UDID stripped). Use the name, not the UDID: `tauri ios dev` matches by name,
and a UDID logs "Could not find an iOS Simulator matching …" then opens Xcode without
hosting the dev-options socket, breaking the build phase. The caveat is repeated above the
`dev-ios` recipe in the `Makefile`.

To default `bun tauri:dev:ios` to a simulator, unpair the phone in Xcode → Window → Devices
and Simulators → right-click → Unpair.

### First run

~10 min on a cold cache:

- Rust compile for `aarch64-apple-ios-sim` (or `aarch64-apple-ios` for device)
- Xcode workspace generation in `src-tauri/gen/apple/`
- Swift wrapper compile

Subsequent runs are incremental.

### iOS device / TestFlight

`make build-ios` requires Apple Developer signing certs and a provisioning profile. CI
handles release builds.

## Android

### Prerequisites

- **Android Studio** (https://developer.android.com/studio), which bundles Java 17 and the
  Android SDK.
- `ANDROID_HOME` pointing at the SDK. On macOS:
  ```bash
  export ANDROID_HOME=$HOME/Library/Android/sdk
  export PATH="$PATH:$ANDROID_HOME/platform-tools:$ANDROID_HOME/emulator"
  ```
  Add to `~/.zshrc` (or `~/.bashrc`). `make doctor` checks `ANDROID_HOME` and `adb`.
- An **AVD** (Android Virtual Device) created and booted: Android Studio → Device Manager →
  Create Virtual Device. Pick a Pixel with a recent system image.
- `adb` on `PATH` (ships at `$ANDROID_HOME/platform-tools`).
- **NDK** via Android Studio → SDK Manager → SDK Tools → NDK (Side by side). Tauri picks it
  up automatically.
- **Rust Android targets**, installed automatically by `tauri android init`
  (`aarch64-linux-android`, `armv7-linux-androideabi`, `i686-linux-android`,
  `x86_64-linux-android`).

### Running

```bash
# 1. Boot an AVD (from Android Studio's Device Manager, or:)
emulator -avd Pixel_7_API_34 &

# 2. Once the emulator is running:
make dev-android
```

### Android package identifier mismatch

`tauri.conf.json` uses `net.thunderbird.thunderbolt` (prod); `tauri.dev.conf.json` overrides
it to `net.thunderbird.thunderbolt.dev` so both coexist on a phone. Tauri's `gen/android/` is
single-identifier, so switching configs requires a re-init, which `make dev-android` does on
every run. A following `make build-android` re-inits back to prod; that is normal.

The re-init is destructive: `dev-android-init` runs `rm -rf src-tauri/gen/android` before
`tauri android init`, and that tree is committed (44 tracked files) with hand-maintained
sources in it (next section). Restore it before committing, or the diff drops those files
and swaps the prod-identifier scaffold for the dev one:

```bash
git checkout src-tauri/gen/android
git clean -fd src-tauri/gen/android
```

### Generated vs. hand-maintained native sources

`src-tauri/gen/android` is checked in despite being generated, because some files in it are
ours. Under `gen/`, `src-tauri/.gitignore` excludes only `/gen/schemas`; the rest is tracked
on purpose.

| File                                                                   | What is hand-maintained                                                                                                                                                                                                                                           |
| ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `app/src/main/java/net/thunderbird/thunderbolt/PlatformUtilsPlugin.kt` | The whole file: a `@TauriPlugin` exposing `getAndroidInsets` and `setBarColor`. `src-tauri/src/platform_utils.rs` registers it with `register_android_plugin("net.thunderbird.thunderbolt", "PlatformUtilsPlugin")`, so the package path must match that literal. |
| `app/src/main/java/net/thunderbird/thunderbolt/MainActivity.kt`        | The `onWebViewCreate` override that disables over-scroll and pins the WebView to the top, keeping keyboard layout on the JS `useKeyboardInset` / `--kb` path instead of native scroll-into-view.                                                                  |
| `app/src/main/AndroidManifest.xml`                                     | `RECORD_AUDIO` / `MODIFY_AUDIO_SETTINGS` plus the microphone feature (voice mode), the leanback entries (Android TV), and the `FileProvider` block pointing at `res/xml/file_paths.xml`.                                                                          |

Regenerable scaffold sits in the same files: the manifest's deep-link `intent-filter` carries
an `AUTO-GENERATED. DO NOT REMOVE.` marker and is rewritten. Hand-edits to generated content
do not survive a re-init.

`src-tauri/gen/apple` is committed too (Xcode project, `project.yml`, `Podfile`,
entitlements, `Info.plist`, app icons), but no Makefile target deletes it, so it has no
equivalent of the Android clobber.

### Common Android crashes

- **`ClassNotFoundException: net.thunderbird.thunderbolt.PlatformUtilsPlugin`**:
  `gen/android` was initialized for the wrong identifier. `make dev-android` re-inits each
  run. After a direct `bun tauri:dev:android`, run `make dev-android-init` first.
- **`No provider set` panic in dev**: fixed in `src-tauri/src/lib.rs` via
  `rustls::crypto::aws_lc_rs::default_provider().install_default()` before the devtools
  plugin loads. If it returns after a Tauri upgrade, upstream may have moved to a different
  crypto provider.

## Common Issues (All Platforms)

- **Backend not reachable from the device/emulator.** Tauri starts Vite on the Mac at
  `:1420` and the webview fetches from it. iOS simulator and Android emulator usually
  forward `localhost` correctly; a physical device needs `TAURI_DEV_HOST=0.0.0.0` and your
  Mac's LAN IP.
- **CORS on `api.anthropic.com` in BYO-key mode.** The webview enforces browser CORS on
  every Tauri target, so BYO-key calls cannot hit a provider directly. They don't:
  `src/lib/proxy-fetch.ts` routes them through the universal proxy at `/v1/proxy`
  (`backend/src/proxy/routes.ts`), wrapping provider headers as `X-Proxy-Passthrough-*`,
  which the proxy strips before calling upstream. The `tauri-plugin-http` direct path is
  compiled out of every build here: `src-tauri/src/lib.rs` registers it only under the
  `native_fetch` Cargo feature, which defaults off (`src-tauri/Cargo.toml`) and is passed by
  no build, so `createProxyFetch` uses the proxy even when `proxy_enabled` is off.

## Local desktop builds

`make build-desktop-local` runs `bun tauri build --bundles app dmg` and prints the path to
`src-tauri/target/release/bundle/macos/Thunderbolt.app`, so it is macOS-only. It skips the
updater bundle, which needs `TAURI_SIGNING_PRIVATE_KEY`; CI owns signed releases.

Two things differ from CI, both from `src-tauri/.cargo/config.toml`:

- `rustflags = ["-C", "target-cpu=native"]` on all four desktop targets, so the binary may
  use instructions the receiving machine lacks (illegal-instruction crash at launch). Fine
  where you built it, not for sharing. `.github/workflows/desktop-release.yml` neutralises
  it with `RUSTFLAGS: ''` on the release jobs and `RUSTFLAGS: '-C target-cpu=x86-64'` on the
  Intel build.
- `rustc-wrapper = "../scripts/rustc-wrapper.sh"`, which `exec`s `sccache` when it is on
  `PATH` and the plain compiler otherwise. sccache is therefore optional, and installing it is
  what makes rebuilds cheap. CI clears it with `RUSTC_WRAPPER: ''`.
