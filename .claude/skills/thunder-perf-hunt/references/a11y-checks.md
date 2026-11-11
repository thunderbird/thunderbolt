# Accessibility checks — axe-core probe

`scripts/probes/a11y.ts` runs [axe-core](https://github.com/dequelabs/axe-core)
against every scenario, in **both browsers**, and emits `a11y` findings.
Accessibility defects are treated as first-class bugs, not warnings: broken
labels, missing landmarks, and unreadable contrast are real user-facing
failures.

## How it runs

- **Inline injection (COEP-safe).** The app ships
  `Cross-Origin-Embedder-Policy: credentialless`, so axe cannot be pulled from a
  CDN `<script src>`. The probe resolves the local `axe-core/axe.min.js`
  devDependency (`require.resolve`, with an absolute fallback path) and injects
  it with `page.addScriptTag({ path })`, then calls `window.axe.run()`.
- **Per scenario.** It runs once per `(browser × scenario)` after the route
  settles and the scenario's `interact` has run, so it sees the same post-load
  DOM the perf probes measured.
- **Fail-open.** Any failure at the injection boundary returns an empty list —
  the harness never crashes on a page axe can't analyze.
- **Compact output.** Each violation is reduced to `{ ruleId, impact, help,
  selectors }` (`A11yViolation` in `scripts/lib/types.ts`), capped at 25 per
  page.

## What becomes a finding

By default **only `critical` and `serious` impacts** are promoted to findings
(see the filter in `scripts/report.ts`); `moderate` and `minor` are recorded in
the report but not surfaced as candidates. Severity maps `critical → high`,
`serious → medium`. Because the probe runs in both engines, the report merges a
rule seen in both Chromium and Firefox into a single finding listing both
browsers.

## Common rule categories and the standard fix

| axe rule(s) | What it means | Standard fix |
| --- | --- | --- |
| `color-contrast` | Text/background contrast below WCAG AA (4.5:1 body, 3:1 large). | Adjust the token/class to a compliant pair; use the theme's `--foreground`/`--muted-foreground` values, don't hand-pick a lighter gray. |
| `aria-*` (e.g. `aria-required-attr`, `aria-valid-attr-value`, `aria-required-children`) | An ARIA role is present but its required attributes/children are missing or invalid. | Prefer a native element (`<button>`, `<nav>`) over a `role` + hand-rolled ARIA. If ARIA is required, supply every attribute the role mandates. |
| `label` / `label-title-only` | A form control has no programmatic label. | Associate a `<label htmlFor>`, wrap the control in a `<label>`, or add `aria-label`/`aria-labelledby`. A `title` or placeholder alone does not count. |
| `image-alt` | `<img>` (or `role="img"`) with no text alternative. | Add `alt` — descriptive for meaningful images, `alt=""` for decorative ones. For icon buttons, label the *button*, not the icon. |
| `region` | Content sits outside any landmark region. | Wrap page content in landmarks (`<main>`, `<nav>`, `<header>`). Exactly one `<main>` per view. |
| `button-name` / `link-name` | An interactive control has no accessible name. | Give icon-only buttons/links an `aria-label` or visually-hidden text. |
| `document-title` / `html-has-lang` | Missing `<title>` or `lang` on `<html>`. | Set a route-appropriate document title and `lang="en"` on the root element. |

## Cross-browser note

Contrast and ARIA computations are engine-independent, so most `a11y` findings
reproduce identically in Chromium and Firefox. When a finding appears in only
one engine, treat it like any single-browser finding and verify it — see
[gecko-profiler.md](gecko-profiler.md) for the Firefox-only investigation path
and [finding-schema.md](finding-schema.md) for the finding contract.
