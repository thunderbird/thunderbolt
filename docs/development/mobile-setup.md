# Mobile Setup

Setting up local Tauri dev for iOS and Android takes more than `make setup` — both
platforms have native SDKs that must be installed and configured first. `make doctor`
checks for these and prints exact install commands; this page explains the why and
the order.

## Quick Reference

| Command                    | Use                                                                                                                                 |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `make dev-desktop`         | Desktop dev. Backend + Tauri shell. Avoids the `:1420` port collision you'd get from `make run` + `bun tauri:dev:desktop` together. |
| `make dev-ios`             | iOS dev on the first **booted** simulator. Open Simulator.app first.                                                                |
| `make dev-android`         | Android dev. Re-inits `gen/android` for the dev identifier on every run ([details](#android-package-identifier-mismatch)).          |
| `make build-desktop-local` | Local desktop release build that skips the updater bundle (which requires `TAURI_SIGNING_PRIVATE_KEY`).                             |

## iOS

### Prerequisites

- **Xcode** 15+ with command-line tools installed (`xcode-select --install`).
- An **iOS Simulator runtime** downloaded — Xcode → Settings → Components.
- `make doctor` checks both.

### Running on a simulator

```bash
open -a Simulator                     # boot a simulator from your Xcode list
make dev-ios                          # targets the booted simulator by name
```

### Wi-Fi-paired iPhone gotcha

`tauri ios dev` will auto-detect any **Wi-Fi-paired iPhone** and try to deploy to
it — even with the cable unplugged. Symptoms: `xcodebuild` fails with
"developer disk image could not be mounted" because the phone needs proper
device-development setup.

`make dev-ios` sidesteps this by passing the booted simulator's **name**
explicitly — `xcrun simctl list devices booted`, with the parenthesised UDID
stripped off. Pass the name, not the UDID: `tauri ios dev` matches devices by
name, and a UDID fails to match (it logs "Could not find an iOS Simulator
matching …") and degrades to opening Xcode without hosting the dev-options
socket, which then breaks the build phase. The caveat is repeated above the
`dev-ios` recipe in the `Makefile`.

If you want `bun tauri:dev:ios` to default to a simulator, unpair the phone in
Xcode → Window → Devices and Simulators → right-click → Unpair.

### What happens on first run

The first iOS build is slow (~10 min cold cache) because of:

- Rust compile for `aarch64-apple-ios-sim` (or `aarch64-apple-ios` for device)
- Xcode workspace generation in `src-tauri/gen/apple/`
- Swift wrapper compile

Subsequent runs are incremental.

### iOS device / TestFlight

Local TestFlight-style builds (`make build-ios`) require Apple Developer signing
certs and a provisioning profile — out of scope for the local dev loop. CI handles
release builds.

## Android

### Prerequisites

- **Android Studio** (https://developer.android.com/studio) — bundles Java 17
  and the Android SDK.
- `ANDROID_HOME` env var pointing at the SDK. On macOS:
  ```bash
  export ANDROID_HOME=$HOME/Library/Android/sdk
  export PATH="$PATH:$ANDROID_HOME/platform-tools:$ANDROID_HOME/emulator"
  ```
  Add to your `~/.zshrc` (or `~/.bashrc`). `make doctor` checks `ANDROID_HOME`
  and `adb`.
- An **AVD (Android Virtual Device)** created and booted — Android Studio →
  Device Manager → Create Virtual Device. Pick a Pixel with a recent system
  image.
- `adb` on `PATH` (ships with the SDK at `$ANDROID_HOME/platform-tools`).
- **NDK** — installed via Android Studio → SDK Manager → SDK Tools → NDK
  (Side by side). Tauri picks it up automatically.
- **Rust Android targets** — installed automatically by `tauri android init`
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

`tauri.conf.json` uses identifier `net.thunderbird.thunderbolt` (prod) and
`tauri.dev.conf.json` overrides to `net.thunderbird.thunderbolt.dev` so dev
builds and prod builds can coexist on a phone. But Tauri's `gen/android/` is
single-identifier — switching configs requires re-init.

`make dev-android` does the re-init for you on every run. If you also want to
do a release build (`make build-android`, which uses the prod identifier), expect
the first run after Android dev to re-init for the prod path; that's normal.

The re-init is destructive: `dev-android-init` runs `rm -rf
src-tauri/gen/android` before `tauri android init`, and that tree is committed
(44 tracked files) with hand-maintained sources in it — see the next section.
Restore it before you commit anything else, or the diff will drop those files
and replace the prod-identifier scaffold with the dev one:

```bash
git checkout src-tauri/gen/android
git clean -fd src-tauri/gen/android
```

### Generated vs. hand-maintained native sources

`src-tauri/gen/android` is checked in even though Tauri generates it, because
some of the files in it are ours and have nowhere else to live. Under `gen/`,
`src-tauri/.gitignore` excludes `/gen/schemas` and nothing more, so the rest of
the tree is tracked on purpose.

| File                                                                   | What is hand-maintained                                                                                                                                                                                                                                              |
| ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `app/src/main/java/net/thunderbird/thunderbolt/PlatformUtilsPlugin.kt` | The whole file — a `@TauriPlugin` exposing `getAndroidInsets` and `setBarColor`. `src-tauri/src/platform_utils.rs` registers it with `register_android_plugin("net.thunderbird.thunderbolt", "PlatformUtilsPlugin")`, so the package path has to match that literal. |
| `app/src/main/java/net/thunderbird/thunderbolt/MainActivity.kt`        | The `onWebViewCreate` override that disables over-scroll and pins the WebView to the top, so keyboard layout stays with the JS `useKeyboardInset` / `--kb` path instead of the native scroll-into-view.                                                              |
| `app/src/main/AndroidManifest.xml`                                     | `RECORD_AUDIO` / `MODIFY_AUDIO_SETTINGS` plus the microphone feature (voice mode), the leanback entries (Android TV), and the `FileProvider` block pointing at `res/xml/file_paths.xml`.                                                                             |

The rest is regenerable scaffold, and it sits in the same files: the manifest's
deep-link `intent-filter` carries an `AUTO-GENERATED. DO NOT REMOVE.` marker and
will be rewritten. Hand-edits to generated content do not survive a re-init.

`src-tauri/gen/apple` is committed too — the Xcode project, `project.yml`,
`Podfile`, entitlements, `Info.plist` and the app icons — but no Makefile target
deletes it, so it has no equivalent of the Android clobber.

### Common Android crashes

- **`ClassNotFoundException: net.thunderbird.thunderbolt.PlatformUtilsPlugin`** —
  `gen/android` was initialized for the wrong identifier. `make dev-android`
  re-inits each run. If you ran `bun tauri:dev:android` directly, run
  `make dev-android-init` first.
- **`No provider set` panic in dev** — already fixed in `src-tauri/src/lib.rs`
  via `rustls::crypto::aws_lc_rs::default_provider().install_default()` before
  the devtools plugin loads. If you see it again after a Tauri upgrade, the
  upstream may have moved to a different crypto provider; re-check.

## Common Issues (All Platforms)

- **Backend not reachable from the device/emulator.** Tauri starts Vite on the
  Mac at `:1420` and the device/emulator's webview tries to fetch from it. On
  iOS simulator + Android emulator, `localhost` typically forwards correctly.
  On a physical device, you'll need `TAURI_DEV_HOST=0.0.0.0` and your Mac's
  LAN IP.
- **CORS on `api.anthropic.com` in BYO-key mode.** The webview enforces browser
  CORS on every Tauri target, so BYO-key calls cannot hit a provider directly.
  They already don't: `src/lib/proxy-fetch.ts` routes them through the universal
  proxy at `/v1/proxy` (`backend/src/proxy/routes.ts`), wrapping the provider's
  headers as `X-Proxy-Passthrough-*`; the proxy strips that prefix back off
  before calling the upstream. The direct-to-upstream alternative
  via `tauri-plugin-http` exists but is compiled out of every build in this repo
  — `src-tauri/src/lib.rs` registers the plugin only under the `native_fetch`
  Cargo feature, which defaults to off (`src-tauri/Cargo.toml`) and is passed by
  no build here — so `createProxyFetch` falls back to the proxy even when the
  `proxy_enabled` toggle is off.

## Local desktop builds

`make build-desktop-local` runs `bun tauri build --bundles app dmg` and prints
the path to `src-tauri/target/release/bundle/macos/Thunderbolt.app`, so it is
macOS-only. It skips the updater bundle, which would need
`TAURI_SIGNING_PRIVATE_KEY`; CI owns signed releases.

Two things about a local Rust build differ from CI, both from
`src-tauri/.cargo/config.toml`:

- It sets `rustflags = ["-C", "target-cpu=native"]` for all four desktop targets,
  so the binary may use instructions the machine you hand it to lacks (an
  illegal-instruction crash at launch). Fine for testing where you built it, not
  for sharing. `.github/workflows/desktop-release.yml` neutralises it — `RUSTFLAGS: ''`
  on the release jobs and `RUSTFLAGS: '-C target-cpu=x86-64'` on the Intel build.
- It sets `rustc-wrapper = "../scripts/rustc-wrapper.sh"`, which `exec`s `sccache`
  when it is on `PATH` and the plain compiler otherwise. That is why sccache is
  optional; it is also why installing it is what makes rebuilds cheap. CI clears
  the wrapper with `RUSTC_WRAPPER: ''`.
