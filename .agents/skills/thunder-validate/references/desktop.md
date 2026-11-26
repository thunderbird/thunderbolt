# macOS Tauri and desktop alternatives

Contents: isolated dev app; Swift link recovery; native evidence; CLI fallback; Linux/Rust.

## Build and identify the real app

Build from a snapshot outside the checkout; `bun tauri dev --no-watch
--config src-tauri/tauri.dev.conf.json --config <scratch>/override.json` should use
scratch config only. Keep devUrl/beforeDevCommand consistent with the owned Vite server
so a second dev server does not collide. Read package scripts/config/CLI help before
choosing flags, features and binary name. Capture build exit status and launch logs.

If swift-rs cannot link PasskeyBridge with a new SwiftPM build system, first reproduce
and preserve the exact link error. In scratch create a PATH `swift` wrapper that resolves
the real Swift binary **before** prepending its directory, and delegates `swift build`
to `"$realSwift" build --build-system native ...`; forward other Swift commands unchanged.
Check current Swift help supports the option and avoid adding it twice. Pass the wrapper
PATH only to this build. This is an environment workaround, not a tracked source patch.
If it does not resolve the issue, report build BLOCKED; do not call tests passed.

Package the dev executable into a unique scratch `.app` with an Info.plist executable,
product name such as **Thunderbolt Validation** and dev identifier
`net.thunderbird.thunderbolt.dev` (verify config/current profile isolation). Avoid the
production bundle identifier. Save any code-signing/ad-hoc steps in the handoff.
Have the user close `/Applications/Thunderbolt.app` first, saving work; do not kill it.
Launch the validation bundle with `open <scratch>/Thunderbolt\ Validation.app`.
Confirm app path, PID, front window and profile before typing. A successful build or
`open` exit is not proof the window works. Check separate dev profile/device registration.

When Web Inspector is available, evaluate
`await window.__TAURI__.core.invoke('capabilities')` and retain sanitized native_fetch
capability evidence; also inspect JS errors/network. Treat `plugin http not found` as a
failure when the executed path expects native HTTP. Current builds may legitimately
proxy when native_fetch is false: derive expectations from code and actual capabilities.

## Drive or hand off

Drive native macOS windows only with native Computer Use tools that answer in the
current session. Terminal agent CLIs usually have none: record **desktop
BLOCKED-in-session** and warn before runtime work. Browser automation never counts as
desktop evidence.

Offer and prepare the Claude Desktop alternative: fill the bundled
`assets/desktop-computer-use-prompt.md` with the scratch directory, absolute skill path,
test email, app name, provider URL/key name and exact scoped steps. Prune provider/routing steps when outside the requested scope (e.g. login-only). Save
a ready-to-paste copy in scratch with all placeholders resolved and give its path to the user. Ask them
to start Claude Desktop with **Computer use ON**. The Desktop GUI agent may not run
shell: it instructs the user to execute the exact terminal helper command at each gate,
then pastes with Cmd+V. The user reports only safe event summaries/booleans, never codes
or keys. Bundled `scripts/desktop-helper.sh` dispatches OTP/key/clear/mark/events; run
it with `bash` and absolute paths. Clipboard values are submitted before screenshots.
Keep desktop pending until the returned evidence is reviewed against the matrix.

The third option is osascript/System Events only after explicit user Accessibility
consent for the driving terminal. Explain the required app in System Settings and do
not grant permissions silently. Verify AX window/control access, use semantic controls
where possible, and retain real screenshots/assertions. Permission alone is not a pass.

## Linux desktop alternative

Offer Linux Docker/WebDriver as a distinct target; it cannot certify macOS shell,
Keychain/passkeys/tray or Cocoa behavior. Prepare a Docker build/run recipe in scratch
from the current `.github/workflows/nightly.yml` Linux native job: Rust, Bun, Node,
CI GTK/WebKit dependencies plus `webkit2gtk-driver`, `xvfb`, `ffmpeg`, and
`cargo install tauri-driver --locked`. Use named cargo registry/git/target caches and
an owned container. Build the snapshot's desktop debug binary with the same native
smoke env/config as nightly; start `e2e/native-smoke/services.sh`, await its health,
then run `bash e2e/native-smoke/linux.sh` **inside** Linux. Confirm network/hostnames
from inside the container (Docker macOS host access differs from Linux host networking).
The helper starts Xvfb/WebDriver/recording and targets the debug binary from linux.ts;
it is not a standalone Docker image and assumes services/build already exist. Copy its
`/tmp/native-smoke/` artifacts into scratch and review them. Its current 1600×1200,
15fps recording is native smoke evidence, not validate-locally's 1080p/30fps video gate.

## Rust checks when macOS linking fails

Read the **current** `.github/workflows/ci.yml` `rust` job and mirror it in an owned
Linux container using the snapshot, not source edits. CI currently installs
libwebkit2gtk-4.1-dev, build-essential, curl, wget, file, libxdo-dev, libssl-dev,
libayatana-appindicator3-dev and librsvg2-dev. Use named Cargo registry/git/target
volumes; set `CARGO_INCREMENTAL=0`, `RUSTC_WRAPPER=''`. Run the current guard script,
`cargo build --all-targets`, `cargo clippy --workspace --all-targets -- -D warnings`,
and `cargo test --workspace` in src-tauri, plus the separate ACP crate checks if scoped.
Record exit statuses. Linux test success supplements native UI evidence; preserve the
macOS linking failure and any platform-specific testing gap in the final matrix.
