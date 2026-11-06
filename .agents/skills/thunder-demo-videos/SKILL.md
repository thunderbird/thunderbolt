---
name: thunder-demo-videos
description: Record and refresh authentic Thunderbolt desktop, mobile, and CLI product videos, including new-feature walkthroughs, pacing edits, and website-ready exports.
---

# Thunderbolt product demos

Make concise, convincing videos of the actual app. Use an existing relevant checkout/PR when one is already in progress. Inspect its `AGENTS.md`, website preview components, and current edit recipes before changing assets. This skill does not authorize a deployment or change the app's permissions.

## Choose the story

- For a new feature, inspect its real UI and working behavior first. Choose a plausible, public demo task that benefits from it. Curiosity, making things, user control, and useful work fit Thunderbolt; avoid feature claims the session cannot demonstrate.
- Desktop usually works well as prompt → response → side browser/action → visible result. Choose an attractive relevant page and coordinate its palette with the app. Avoid sources dominated by ads or uncooperative embeds.
- Mobile can focus on a clear chat response and a natural next action. Use an actual mobile build or an honest responsive preview; record which it is. Keep device chrome consistent with the website and avoid nested device mockups.
- CLI should solve a natural-language task in a disposable fixture using real tools. Verify any created files, calculations, or claimed passing tests. Don't feed the model the answer or fabricate terminal output.

## Capture

Read [references/capture.md](references/capture.md) for native window recording or real PTY capture/replay. Use the supported UI tools to operate the app; the native helper records only a selected window and does not automate input.

Keep raw masters outside the repository, with a brief story/feature note and the app version, model, theme, viewport, and verification result. Never overwrite the master. Use already configured providers without exposing credentials; prepare the demo workspace before recording.

Prefer continuous native capture over screenshot sampling for GUI animation. Aim for smooth real motion (typically 30–60 fps), inspect actual frame intervals, and don't turn still frames into a nominal “60 fps” claim. Run a short probe after window/display changes. Pause your own encodes and local inference during capture if they compete with the compositor; completed-response footage is fine when clearly recorded as such. Don't stop unrelated work to improve FPS.

## Edit for pace

Run `scripts/demo.py inspect INPUT --output SESSION/inspection` to generate a contact sheet and cadence report. Locate the meaningful beats, then write explicit keep ranges in **original-master seconds**.

Keep a short readable response beat, then move promptly into the action. Cut idle holds, waiting on model/network responses, empty setup, and dead tails. A 10–20 second clip is often enough, but retain more time when real activity or reading warrants it. Preserve actual motion and output inside each kept segment; favor clean cuts over speeding up UI animations. Check the loop as well as the first and last frames.

Read [references/editing.md](references/editing.md) for recipe fields and commands. The editor generates the video, a poster from the same edited footage, and a provenance report. Optional overlay cleanup is for specifically requested cosmetic recording chrome, not hiding errors or improving the apparent outcome of a task.

## Integrate and verify

For this repository, `web/demo-edits.json` holds the selected recipes. Export with:

```sh
python scripts/demo.py edit /path/to/checkout/web/demo-edits.json \
  --source-dir /path/to/raw-masters --output-dir /path/to/checkout/web/public \
  --report /path/to/session/exports.json
```

Resolve the `scripts/` path against this skill's directory; use the prepared Python environment from the capture reference. Edit the recipe when the feature/story changes rather than reusing old timestamps blindly.

Update `web/src/components/marketing/spark/product-demos.ts` when dimensions, filenames, or the visible story change. Keep both palettes, static posters, muted inline playback, reduced-motion behavior, offscreen pausing, and the manual pause control. The website supplies the desktop/terminal chrome; remove duplicate review-gallery framing from assets. Inspect the native rounded capture edges at the actual website size, since black corners can be baked into the recording.

Run `scripts/demo.py check OUTPUT.mp4`, the web build, and appropriate source checks. Visually review light/dark desktop and a phone-width layout, source changes between clients, playback/pause, corners, and poster fallback. Don't claim cadence or outcomes that weren't checked. Update capture notes when cuts, cosmetic cleanup, or PTY replay change the provenance.

If review was requested, present candidates before integration. If selection/integration was already authorized, choose the strongest set and complete it. For commits/pushes, follow the repository's `/thunderpush` rule; don't bypass signing or publish to a different destination.
