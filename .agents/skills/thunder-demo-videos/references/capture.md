# Capture setup

The edit/inspect and CLI helpers use Python 3.9+, FFmpeg/ffprobe, and Pillow. Create an environment outside the repository:

```sh
python3 -m venv /tmp/thunder-demo-tools
/tmp/thunder-demo-tools/bin/python -m pip install -r /path/to/skill/scripts/requirements.txt
```

Use that Python for every helper command. Install FFmpeg through the environment's supported package manager if absent. The native helper additionally needs macOS 15+ and the Apple SDK. Use native recording only where permitted by the session/tool permissions; use the app/browser tool for all clicks and typing.

## Desktop and responsive mobile on macOS

Compile once per source/SDK change, outside the repository:

```sh
xcrun swiftc -parse-as-library -module-cache-path /tmp/thunder-demo-swift-cache \
  /path/to/skill/scripts/capture-window.swift -o /tmp/thunder-demo-capture
/tmp/thunder-demo-capture list
```

`list` defaults to Thunderbolt windows. For a dedicated browser window, filter by its bundle and exact title, for example `list org.mozilla.nightly Thunderbolt`. Re-read the current window ID and geometry for each session; old IDs/crop positions are not reusable.

Write a capture JSON outside the repository:

```json
{
  "windowID": 123,
  "expectedBundleID": "the.bundle.id.from.list",
  "expectedTitle": "Thunderbolt",
  "output": "/absolute/session/raw/desktop-light.mp4",
  "seconds": 45,
  "width": 1920,
  "fps": 60
}
```

Run `/tmp/thunder-demo-capture record /absolute/session/capture.json`. Wait for `RECORDING_STARTED` before the meaningful interaction, and for `RECORDING_FINISHED` before moving on. Recording is H.264, window-only, cursor visible, with audio/microphone disabled. Actual duration/FPS can differ from the request; inspect the file afterward.

For mobile, open a dedicated responsive-preview window using the supported UI tools, set a phone viewport that fits the current display, and identify its bounds from a screenshot. Add `"crop": {"x": 100, "y": 150, "width": 393, "height": 780}` using **logical pixels relative to that window**, not global screen coordinates. Set output width around twice the viewport width, e.g. 786. Exclude browser chrome and resize grips, verify a short recorded probe, then record. These coordinates are illustrative; do not reuse them without observing the actual window.

If another checkout is actively changing and its dev server breaks, use an already built app or a separate stable build; don't repair or reset unrelated work. If local inference reduces capture smoothness, generate the genuine reply first, stop only your model runner, and record reading/acting on the completed conversation. Record that choice in the notes. Avoid repeated retakes for optional polish once the required sequence and motion are good.

## CLI

Authenticate/configure the real CLI first. Use its current `--help` rather than assuming provider flags. Set up a small disposable fixture and record a normal task invocation; don't place credentials in command arguments or the captured display. The recorder does not reset files, add permissive flags, or bypass approvals:

```sh
python scripts/cli.py record --cwd /absolute/demo-fixture \
  --output /absolute/session/feature.cast.json --columns 100 --rows 28 -- \
  thunderbolt [actual-supported-options] 'A natural feature task'
```

The JSON preserves actual ANSI output and timestamps, command, exit code, and timeout status. The helper is for an already configured, noninteractive command. If interactive approval is needed, use an appropriate interactive terminal/recording workflow rather than bypass it. Verify results using real commands and keep their real output as a separate take if needed.

Record the actual terminal window with the native window-capture helper above. List the terminal application’s exact bundle ID and window title, verify the selected window, and capture real typing, output, and scrolling. Use `cli.py record` only when a separate raw PTY log is useful for checking the command’s result; it does not produce a video. Never replace native terminal footage with reconstructed ANSI frames.

Older session assets may contain PTY replays. Preserve their existing provenance rather than relabeling them as native recordings; new or refreshed CLI videos should use native terminal capture.
