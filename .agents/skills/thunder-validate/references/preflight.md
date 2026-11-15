# Capability preflight

Contents: host inventory; session capabilities; platform decisions; exact fallback messages.

Run the bundled preflight in the checkout, save text/JSON in private scratch. It probes
versions, Docker daemon, Xcode/simctl inventory, booted/available simulators, SDK/AVDs,
already-running adb devices, Java 17 homes, Codex/Argent/Playwright. It installs/boots
nothing and avoids starting an adb daemon. Read-only CLI inventory does not authorize
manual mobile driving; select the live target with the device driver's own listing.

Inspect the **actual tool list** for Playwright/browser, Argent MCP or the harness's
device tool, and native Computer Use tools (in Claude Code, `mcp__computer-use__*`). Do
not equate a CLI, installed skill, Electron browser CDP, or a web-browser tool with
native desktop control. Terminal agent CLIs (Claude Code, Codex and similar) ordinarily
lack native Computer Use; Claude Desktop with Computer Use ON is a separate GUI session.
An unusual CLI bridge counts only after a successful native window-inspection call.
Check sandbox loopback/listen/network restrictions with harmless probes; a binary can
exist while the session cannot start or reach servers. Do not silently elevate access.

| Platform | Available evidence required | Degraded case | Blocked case and alternative |
|---|---|---|---|
| Web | Driver can launch a browser; app health + page reachable | UI works but external OAuth/provider credentials missing: block those rows | No driver/loopback: prepare exact Playwright commands + URLs for an unrestricted local session |
| macOS | macOS, Xcode/Rust build, unique app window, native GUI tool succeeds | UI available but Web Inspector unavailable: block unobservable native capability/routing claims | No native Computer use: offer all three desktop alternatives below |
| iOS | macOS/Xcode, simulator runtime, device driver, installed simulator .app | AX/idb fails on new Xcode: Web Inspector WKWebView DOM + driver screenshots | Missing driver/Xcode/runtime: hand off simulator .app, UDID/name, setup and checks to a macOS session with a device driver |
| Android | SDK/AVD or existing emulator, Java 17, device driver, installed APK | AX only unlabeled WebView: inspect via CDP + driver screenshots | Missing SDK/driver/AVD: prepare APK + device/setup commands for a session with a device driver |

Use these messages, translated into the user's language and filled with actual facts:

- **Desktop:** “macOS desktop is BLOCKED in this session: native Computer use tools are
  unavailable in this session. Before runtime work, here are concrete alternatives:
  (1) I can generate a ready-to-paste Claude Desktop prompt for Computer use ON, plus
  terminal helper commands you run for OTP/keys/log evidence; (2) run Linux Tauri via
  Docker, tauri-driver/WebDriver and `e2e/native-smoke/linux.sh` (Linux evidence only);
  (3) use osascript after you explicitly grant Accessibility to the driving terminal.
  I'll continue available platforms and keep macOS blocked until real evidence exists.”
- **iOS:** “iOS is BLOCKED because <missing capability>. I can prepare <simulator .app,
  named simulator and exact checks> for a macOS session with a device driver. WebKit mobile
  emulation can supplement layout checks but cannot validate the iOS app.”
- **Android:** “Android is BLOCKED because <missing capability>. I can prepare <APK,
  AVD/Java 17 setup and exact checks> for a session with a device driver. Chromium mobile
  emulation covers browser layout only.”
- **Web:** “Web is BLOCKED because <driver/network restriction>. I can generate a
  local Playwright handoff with the pinned revision, URLs, test account and assertions;
  unit tests alone will leave runtime checks blocked.”

For every degraded target, state the lost capability, compensating driver and affected
checks before starting. Offer an alternative without implying consent to grant OS
permissions or launch a separate session. Generate the concrete handoff while available
work proceeds. If no alternative is chosen, leave dependent rows BLOCKED.
