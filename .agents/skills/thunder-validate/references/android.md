# Android emulator

When Argent is installed: for setup, load the `argent-android-emulator-setup` skill; for
UI journeys, load the `argent-device-interact` skill and the `argent-test-ui-flow`
skill. For pixel comparisons, load the `argent-screenshot-diff` skill; for video, load
the `argent-screen-recording` skill. For permissions unreachable through app/dialog,
load the `argent-settings-permissions` skill. Without Argent, use the device tool the
harness provides (SKILL.md Harness notes).

List devices with the driver (Argent `list-devices`) and prefer a ready emulator. An AVD
you create for this run goes in the cleanup ledger as `android-avd`. Detect SDK/AVDs and
Java **17** with preflight; do not pin a machine-specific JDK path. Set
JAVA_HOME/PATH for the build only. Build from a snapshot because Tauri dev regenerates
tracked `src-tauri/gen/android`. Check current CLI help/config, then use `bun tauri
android dev <avd> --no-watch --no-dev-server-wait` with the dev override.
Install/restart/capture through the driver when supported. Record serial, AVD/API,
bundle ID, APK/build, backend and Vite URLs. Check that the chosen generated package
matches the dev identifier, not the production app.

An emulator reaches the host via `10.0.2.2`, not its own loopback. Give it a separate
Vite port (e.g. 1426), host binding and backend cloudUrl, with backend CORS/trusted
origin `http://10.0.2.2:<vite-port>`. Read current CSP before choosing HTTP endpoints.
For a loopback fake provider prefer an Argent network-forwarding tool if available;
otherwise `adb -s <serial> reverse tcp:<port> tcp:<port>` is an uncovered transport
setup operation. Record the mapping and remove only that mapping after consent to
cleanup. Use `http://localhost:<allowed-port>/v1` inside the WebView for this case.

If `describe` returns only an unlabeled WebView, retain that finding and inspect the
actual app's WebView via Chromium/CDP. When Argent lacks the forwarding operation,
identify the app PID and socket, then forward
`adb -s <serial> forward tcp:9222 localabstract:webview_devtools_remote_<pid>`.
Choose a free port if occupied. Enumerate `/json/list`, verify page URL/package, and
attach a supported Chromium/CDP tool (Argent Chromium/debugger tools when compatible,
otherwise Playwright CDP). Inspect DOM before interactions; await exact selectors and
assertions. Pair web-content assertions with driver screenshots of the real emulator.
This is transport fallback, not permission to replace Argent-covered device controls.
Native dialogs/keyboard/gestures still need native evidence; mark those rows blocked
if the available accessibility driver cannot reach them.

Use `{{secret:NAME}}` for Argent typing, or read keys in-memory inside the CDP helper;
submit/navigate before capture. Never send plaintext keys through command arguments,
console output or a visible insecure input screenshot. Request fresh OTPs through a
private channel and never persist them. Check auth reload, chat partial stream/Stop,
profile cloudUrl, actual native capabilities, routing and reopen persistence on-device.
