# Mobile Setup

Setting up local Tauri dev for iOS and Android takes more than `make setup` — both
platforms have native SDKs that must be installed and configured first. `make doctor`
checks for these and prints exact install commands; this page explains the why and
the order.

## Quick Reference

| Command | Use |
| --- | --- |
| `make dev-desktop` | Desktop dev. Backend + Tauri shell. Avoids the `:1420` port collision you'd get from `make run` + `bun tauri:dev:desktop` together. |
| `make dev-ios` | iOS dev on the first **booted** simulator. Open Simulator.app first. |
| `make dev-android` | Android dev. Re-inits `gen/android` for the dev identifier on every run (see [F8](#android-package-identifier-mismatch) below). |
| `make build-desktop-local` | Local desktop release build that skips the updater bundle (which requires `TAURI_SIGNING_PRIVATE_KEY`). |

## iOS

### Prerequisites

- **Xcode** 15+ with command-line tools installed (`xcode-select --install`).
- An **iOS Simulator runtime** downloaded — Xcode → Settings → Components.
- `make doctor` checks both.

### Running on a simulator

```bash
open -a Simulator                     # boot a simulator from your Xcode list
make tauri-ios-sim                    # picks the booted UDID, launches Tauri dev
```

### Wi-Fi-paired iPhone gotcha

`tauri ios dev` will auto-detect any **Wi-Fi-paired iPhone** and try to deploy to
it — even with the cable unplugged. Symptoms: `xcodebuild` fails with
"developer disk image could not be mounted" because the phone needs proper
device-development setup.

`make dev-ios` sidesteps this by passing the booted simulator's UDID
explicitly. If you want `bun tauri:dev:ios` to default to a simulator, unpair
the phone in Xcode → Window → Devices and Simulators → right-click → Unpair.

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
make tauri-android
```

### Android package identifier mismatch

`tauri.conf.json` uses identifier `net.thunderbird.thunderbolt` (prod) and
`tauri.dev.conf.json` overrides to `net.thunderbird.thunderbolt.dev` so dev
builds and prod builds can coexist on a phone. But Tauri's `gen/android/` is
single-identifier — switching configs requires re-init.

`make dev-android` does the re-init for you on every run. If you also want to
do a release build (`make build-android`, which uses the prod identifier), expect
the first run after Android dev to re-init for the prod path; that's normal.

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
- **CORS on `api.anthropic.com` in BYO-key mode.** Affects every Tauri target
  because the webview enforces browser CORS. Fix paths: route AI calls through
  `tauri-plugin-http` (native, no CORS), or wait for the universal proxy
  (THU-tracking).
