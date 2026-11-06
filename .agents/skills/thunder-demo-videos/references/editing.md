# Reproducible edits

Keep the master outside the repository. `demo.py` invokes FFmpeg with argument arrays, never a shell. It retains frame timing within each selected segment, concatenates cuts, strips audio, and writes H.264/yuv420p MP4 with fast-start metadata. Posters are WebP frames from the edited result. Both outputs are prepared before either website file is replaced.

```json
{
  "version": 1,
  "clips": [
    {
      "id": "desktop-light",
      "source": "feature/desktop-light.mp4",
      "keep": [
        [2.0, 7.0],
        [15.0, 20.0]
      ],
      "outputWidth": 1920,
      "posterAt": 8.0,
      "output": "videos/marketing/desktop-light.mp4",
      "poster": "images/marketing/screenshots/desktop-light.webp"
    }
  ]
}
```

- `source`, `output`, and `poster` are relative to the explicit source/output directories. The source cannot equal either destination. Keep ranges are ordered, non-overlapping seconds in the original master; `posterAt` is seconds in the edited timeline.
- Optional `crop` is `{ "x": 0, "y": 64, "width": 1920, "height": 1102 }` in source pixels, with even dimensions. Use it for recording/window borders or review-gallery framing, after checking it does not remove content.
- Optional `removeOverlays` is a list of the same rectangle shape. FFmpeg interpolates nearby pixels with `delogo`, before cropping/scaling. Inspect the surrounding pixels across all kept frames first. Use it only for requested cosmetic recording controls on flat backgrounds; keep the rectangle away from actual app text and results. Retake when cleanup would visibly distort the UI.
- `outputWidth` defaults to source width, rounded dimensions must be even. The aspect ratio follows the crop/source. `crf` defaults to 22. Do not force a higher frame rate to disguise low-rate source material.
- Select one recipe with `--only desktop-light`; otherwise all clips run. The required `--report` stores original-source SHA-256, cuts, cleanup rectangles, dimensions, sizes, duration, and measured frame cadence. Keep it with session evidence rather than inside public assets.

## Review

Use `inspect` on source footage to locate beats; its contact sheet labels every sample with its source timestamp. For precise boundaries, narrow the range, for example `inspect INPUT --output SESSION/boundary --start 18 --end 22 --step 0.25`. Scrutinize boundaries with extra frame samples or normal playback when a single contact-sheet step is too coarse. Keep the actual response arriving and enough reading time to understand it, then cut promptly to the action. Remove repeated loading/dialog waits without implying fabricated outcomes. Show a completed result before looping.

Use `check` for codec/audio/cadence, then play the actual files. FPS metadata alone does not prove smoothness: inspect movement and frame-interval outliers. Review first/last frames, every cut, both themes, responsive framing, and the poster. Update the website's dimensions and descriptions if needed; keep its playback/accessibility behavior intact. Document any shortened waits, masked recording chrome, completed-before-capture responses, or PTY replays.

## Helper checks

From the repository root, run the bounded media/PTY tests with the prepared environment:

```sh
DEMO_PYTHON=/path/to/video-env/bin/python bun test ./.agents/skills/thunder-demo-videos/scripts/demo.test.ts --timeout 20000
```

The tests create tiny synthetic footage only in a temporary directory; it is never a product-demo source. They verify cuts/crops, silent H.264 output, WebP posters, master preservation, rejection of invalid recipes, and faithful capture of real command output and exit status.
