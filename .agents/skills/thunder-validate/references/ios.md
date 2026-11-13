# iOS simulator

When Argent is installed, load the relevant skills when their operation is needed;
otherwise use the device tool the harness provides (SKILL.md Harness notes) for the same
operations:

- Setup/reuse: load the `argent-ios-simulator-setup` skill.
- Every UI journey: load the `argent-device-interact` skill and
  the `argent-test-ui-flow` skill.
- Pixel comparisons: load the `argent-screenshot-diff` skill.
- Videos: load the `argent-screen-recording` skill.
- Permissions unreachable through app/dialog: load the `argent-settings-permissions` skill.

List devices with the driver (Argent `list-devices`); prefer a booted simulator. Record
name, UDID, runtime, app bundle ID/build and URL. A simulator you create for this run
goes in the cleanup ledger as `ios-simulator` with its UDID. Boot/install/launch/capture
through the driver when it covers the action; manual `xcrun simctl`/idb is no
replacement for driver interaction. Build from the snapshot using current Tauri config
and `bun tauri ios dev '<simulator name>'` with dev config. A matching name can still
select a paired physical iPhone: inspect build destination, SDK and architecture. Locate
the **simulator** `.app` in build output and install it with the driver explicitly. A
physical-device build is not simulator validation.

Await the auth/chat screen; discover AX targets with `describe` before taps. Use
`await-ui-element` for expected transitions, then verify resulting state. Do not infer
coordinates from screenshots. Use the real permission dialog for the ordinary user
flow, reserving permission-reset tooling for inaccessible states.

New Xcode versions can break idb taps because SimulatorKit is missing. After one
confirmed tool failure, inspect whether the app's WKWebView is exposed through the
Web Inspector protocol. Use an available Web Inspector bridge to enumerate the actual
app/page, inspect DOM selectors, run bounded interactions and JS assertions, and pair
with driver screenshots. DOM driving covers WebView behavior; native dialogs, gestures,
keyboard/safe areas and OS handoffs remain separately blocked until exercised natively.
If no bridge exists in-session, prepare the exact inspector handoff instead of inventing
a tool or calling WebKit emulation iOS evidence. Time-box discovery, then report gaps.

Use `{{secret:NAME}}` through Argent (or the driver's secret placeholder) for
credentials. For a dynamic OTP, use a private in-memory/helper channel supported by the
available driver; do not store sign-in codes in secrets.env, files, chat or reports. In
a user handoff the OTP clipboard helper is safe. Submit/navigate before
`describe`/screenshots of fields that could reveal secrets. Verify cloudUrl, backend
origins and actual `capabilities` where inspectable. Reopen the app for persistence, and
use a second independently identified device for sync checks.