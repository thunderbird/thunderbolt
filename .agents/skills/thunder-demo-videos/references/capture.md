# Capture setup

The edit/inspect and CLI helpers use Python 3.9+, FFmpeg/ffprobe, Pillow, and pyte. Create an environment outside the repository:

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

Render a faithful replay with a system monospace font:

```sh
python scripts/cli.py render /absolute/session/feature.cast.json \
  --output /absolute/session/raw/terminal.mp4 \
  --font /System/Library/Fonts/Menlo.ttc --idle-cap 1.2 --final-hold 2.5
```

On Linux, pass an installed monospace font such as DejaVu Sans Mono. The renderer includes every captured event; it only compresses inter-event waiting. Output is a plain terminal body at 30 fps, ready for website chrome. Record it as a PTY replay, not a native-window video. Keep terminal columns/rows compact enough for the target website size and check that output does not scroll important results away.
