## Your driver: the native app on a device

You test the Thunderbolt app on an iOS simulator or an Android emulator, not in a browser. Wherever this prompt says
browser tool or browser action, read a call to one of the Maestro tools below. The device is set up for you and the
app is already open on it. The URLs in your charter and its "Specs for this charter" paragraph are for the web:
ignore them.

### Tools

You reach the device only through five tools. They may appear only after your first turn: never conclude they are
missing.

- `mcp__maestro__run` runs Maestro commands on the app. Its only argument is `yaml`, a list of commands. Tap, type,
  scroll, wait and reload with it. Its result ends with the layout lines (below).
- `mcp__maestro__inspect_screen` returns the screen as a tree of elements with their text and bounds, then the layout
  lines. Copy the text for a selector from it, exactly as it appears.
- `mcp__maestro__take_screenshot` returns a screenshot and the path of the file it saved.
- `mcp__maestro__cheat_sheet` lists Maestro's commands. `run` refuses some of them (see the rules below).
- `mcp__maestro__read_logs` returns what was logged since your last call: the app's console (`webview:` lines) and
  the backend's 5xx responses (`backend:` lines).

### Commands

```yaml
- tapOn: Continue
- tapOn:
    point: 50%, 40%
- inputText: hello there
- hideKeyboard
- scrollUntilVisible:
    element: Delete account
    direction: DOWN
```

- Tap a text from the screen, or a point given in percent. A point, and the start of a swipe, must lie between 5%
  and 95% on both axes: the screen edges belong to the system.
- Type with `inputText` once the field has focus. Remove text with `eraseText`.
- Reload: `- stopApp` then `- launchApp`, in the same `run`. That is the reload a function marked "(after a reload)"
  and a `lost-on-reload` finding need. `stopApp` and `killApp` must always be followed by `launchApp`.
- `back` may only be the last command of a `run`.
- Never write `${...}` while you explore. Never use `clearState`, `openLink`, `runScript` or `takeScreenshot` (use the
  `take_screenshot` tool). `run` refuses these and anything else that could leave the app. A refused run returns
  `denied:` and the problem: fix the flow instead of sending it again.

### How to work on the device

- After every major action (submit, save, delete, navigate, reload) call `read_logs`. A `webview:` line with an error
  is a `console-error` or a `page-error`; a `backend:` line is an `http-5xx`.
- Take a screenshot with `take_screenshot` of every new screen, and again whenever the keyboard opens (after you tap
  a text field, and on screens that focus a field by themselves), then look at it the way a user would.
- The layout lines come at the end of every `run` and `inspect_screen` result. `[qa-layout] ready keyboard=…` says
  the screen was measured, with the keyboard's bounds or `none`. Every other `[qa-layout] <kind> <target>` line is a
  `layout` finding with that line as its evidence. Each problem is reported once per app launch. A `[qa-gate]` line is
  a note from the harness and never a finding.
- To attach a file, use the app's attach button and pick the file in the system picker. The fixtures are already on
  the device: `sample.png` in the photo library on iOS, `sample.png` and `sample.pdf` in Downloads on Android.
- The passkey step of onboarding may not complete on a simulator. Skip it; that is not a bug.
- On iOS (platform `ios`) the app's AI is always the local fake, even when your charter or case says it is real. Only
  the Anthropic models (select "Opus 5.5") reply, and with the fake reply. An error from any other model is expected
  there and is not a finding.

### Findings on the device

- A `visual` finding's `screenshot` is the part of the saved file's path from `maestro/` on, for example
  `maestro/shot-3.jpg`.
- Any other finding has `"repro_flow": "repro/<n>.yaml"` instead of `repro_spec`, and its second file is
  `<output directory>/repro/<n>.yaml`: a Maestro flow that fails while the bug exists and passes once it is fixed.
  Write only the list of commands, with no `appId` header and no `---`. The replay runs it on a freshly installed
  app, so it starts with `- launchApp`, signs in with `${EMAIL}` as the address and `12345678` as the code, reaches
  the screen and repeats the action. Then it asserts the expected behaviour with `assertVisible` or
  `assertNotVisible`. `${EMAIL}` is the only variable, a fresh address for each replay; the rules for `run` hold for
  everything else.
- A fresh app is slower than the one you explored, so before each step the flow waits for a text of the screen that
  step needs, then acts on it, and taps a label rather than a point wherever the element has a text.
- Unless the bug is on the sign-in screen itself, start the flow with this sign-in, copied as it is:

  ```yaml
  - launchApp
  - extendedWaitUntil:
      visible: Want early access?
      timeout: 120000
  - waitForAnimationToEnd
  - retry:
      maxRetries: 2
      commands:
        - tapOn:
            text: Email
            retryTapIfNoChange: true
        - eraseText
        - inputText: ${EMAIL}
        - assertVisible: ${EMAIL}
  - tapOn: Continue
  - extendedWaitUntil:
      visible: Check your email
      timeout: 120000
  - inputText: '12345678'
  ```

  Then wait for the first screen after sign-in, which depends on your session's build:
  - a `c1-first-run` session (onboarding on): `- extendedWaitUntil: {visible: Welcome to Thunderbolt!, timeout: 120000}`
  - any other session: `- extendedWaitUntil: {visible: Ask me anything…, timeout: 120000}`

  On a fresh install the c1 build opens onboarding on the privacy step. When your flow next waits for a text that
  screen does not show, or ends there for a layout finding about an element it does not show, the replay ticks the
  privacy checkbox and skips Connect Google for it.

- In a `layout` finding the flow only reaches the screen and stops, with no assertion (replay drops one that ends
  on `assertVisible` or `assertNotVisible`): the harness measures the
  screen after the flow ends. So the flow ends on the broken screen: for a field behind the keyboard, with that field
  still focused and the keyboard open, never with `hideKeyboard` or `back`. In a `console-error`, `page-error` or `http-5xx` finding the flow repeats the action,
  and the harness reads the logs while it runs.
- Two-device charter (c7): device A is the app on this device, through the Maestro tools, not
  `mcp__playwright__*`. Device B is a web browser,
  through `mcp__playwright_b__*`, at http://localhost:1424; the browser block below holds for it only, so read
  `mcp__playwright_b__*` wherever it names a browser tool. A bug that shows
  only on device B gets a `repro_spec` and a `repro/<n>.spec.ts`, as on the web.
