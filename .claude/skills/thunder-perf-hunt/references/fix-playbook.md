# Fix playbook

A catalog keyed by `FindingCategory` (from `scripts/lib/types.ts`). For each: a root-cause checklist and the **architectural** fix that fits this codebase. Two rules override everything below, from `CLAUDE.md`:

1. **Architectural fixes, not band-aids.** No shortcuts, hacky workarounds, or defensive `try/catch` around a symptom. Fix the cause at the right layer.
2. **Every fix must include a before/after number** from re-running the probe (`beforeAfter` on the `Finding`). A fix with no moved metric is not a fix.

Prefer optimistic code over defensive code; let errors surface. Follow the React and route-splitting rules verbatim.

---

## `web-vital` (LCP / INP / CLS / FCP / TTFB)

**Root-cause checklist:**
- LCP: is the largest element a late-loading image, a web font swap, or a component that mounts after data? Check the attributed selector.
- CLS: which node shifts (attribution selector)? Missing width/height, late-injected banner, font swap reflow?
- INP: which element (attribution)? Is the handler doing sync work on the main thread?
- FCP/TTFB slow only on the dev server → likely measurement artifact, verify against a prod-like build.

**Fixes:**
- LCP image → set explicit dimensions, preload the hero, avoid gating it behind a data fetch; move it off a lazy chunk if it's on the landing path.
- CLS → reserve space (aspect-ratio / fixed dimensions); avoid inserting content above existing content after paint.
- INP → move the expensive handler work off the critical path (see `long-task` below); keep the handler to a state update and defer the rest.
- Chat/landing must feel instant — keep `ChatLayout`/`ChatDetailPage` static in the entry bundle (`CLAUDE.md` route rules); don't regress them to lazy.

---

## `unnecessary-render`

Fully covered in **`react-rerender-playbook.md`** — unstable props → `useMemo`/`useCallback`/hoist; context churn → split/memoize; derived state in effect → compute during render; cascades → `React.memo` on leaf or move state down; lists → stable keys + virtualization. Prove with `commits` before/after.

---

## `long-task` (LoAF ≥200ms / longtask ≥120ms)

**Root-cause checklist:**
- Read the LoAF `sourceURL:sourceCharPosition sourceFunctionName` — that's the offending function.
- One big synchronous chunk, or many small ones coalesced into one frame?
- Is it startup work that could run after first paint?

**Fixes:**
- **Break up the work** — chunk large loops, yield between batches.
- **Defer non-critical work post-paint** — schedule with `requestIdleCallback` / a scheduler yield, or the app's existing post-paint deferral pattern (e.g. `loadMotionFeatures`-style lazy init after mount) instead of doing it during the init path.
- **Move pure CPU work to a Web Worker** when it's genuinely heavy (parsing, crypto, diffing) and doesn't need the DOM.
- Don't wrap in `setTimeout(0)` and call it done — that hides the work without reducing it. Confirm the LoAF is gone, not just relocated.

---

## `layout-thrash` (forced style/layout ≥30ms in a frame)

**Root-cause checklist:**
- Find the read-after-write loop: reading `offsetWidth`, `getBoundingClientRect`, `scrollHeight`, `getComputedStyle` in the same frame you mutate styles/DOM.
- Often inside a loop over elements, or a resize/scroll handler.

**Fixes:**
- **Batch reads then writes** — read all layout values first, then apply all mutations (avoid interleaving).
- Cache measurements; don't re-read layout inside a loop.
- Use `ResizeObserver`/`IntersectionObserver` instead of polling layout in a handler.
- For animation, prefer `transform`/`opacity` (compositor-only) over properties that force reflow.
- Verify via the LoAF `forcedStyleAndLayoutDuration` dropping below `FORCED_LAYOUT_MS` (Chromium-only signal — see `metrics-and-thresholds.md`).

---

## `memory-leak` (heap Δ ≥3MB or detached nodes >0)

**Root-cause checklist:**
- An effect subscription/listener/timer with no cleanup.
- A closure or module-level collection retaining unmounted component state.
- Detached DOM nodes held by a ref, cache, or event handler.

**Fixes:**
- Return a cleanup from every `useEffect` that subscribes/listens/timers (this is a *legitimate* effect use per `CLAUDE.md`): `removeEventListener`, unsubscribe SDK/WebSocket, `clearInterval`.
- Release references on unmount; don't cache DOM nodes across mount cycles.
- Confidence starts `low` — the fix is proven only by repeating the mount/unmount cycle N times after a forced GC and showing the heap no longer grows monotonically and detached nodes return to 0.

---

## `bundle` (JS chunk ≥400KB)

**Root-cause checklist:**
- Is the heavy module in the **entry chunk**? Run `bun scripts/analyze-bundle.ts` and inspect `suspectEntryModules`.
- Is it on the chat/landing critical path, or a secondary/settings route?

**Fixes (follow `CLAUDE.md` route code-splitting rules exactly):**
- **Route-level `React.lazy(() => import(...))`** for anything not on the chat/landing critical path — all settings/admin pages, secondary features (`TasksPage`, `AutomationsPage`), `WaitlistPage`, SSO flows. Pair with a content-area `<Suspense fallback>` around the relevant `<Outlet />` so nav stays mounted.
- **Keep static** in the entry bundle: `ChatLayout`, `ChatDetailPage`, layouts (`SettingsLayout`, `WaitlistLayout`), and small auth/error pages — lazy-loading these creates a waterfall or costs more in per-chunk overhead than they save.
- **Defer heavy non-route deps post-paint** (e.g. `loadMotionFeatures`) rather than importing them at module-eval time in the entry path.
- Don't ship a big dep to shrink another — check if a lighter library or a subpath import removes the weight.

---

## `network`

**Root-cause checklist:** render-blocking request on the critical chain? Oversized/uncompressed asset? Waterfall (request depends on a prior response)?

**Fixes:** preload/parallelize critical requests; compress/resize assets; use the app's `HttpClient` (`src/lib/http.ts`), never bare `fetch`; avoid sequential fetch chains where a batch or parallel fetch works.

---

## `console-error`

**Root-cause checklist:** is it our code or a third party? Dev-only warning or a real runtime error? (Dev-only warnings and third-party/analytics noise are **auto-refuted** — see `verification-rubric.md`.)

**Fix:** address the actual error at its source. Do not silence with a `try/catch` that swallows it (`CLAUDE.md`: no error-swallowing). Handle errors architecturally at a boundary if appropriate.

---

## `crash` (uncaught page error)

**Root-cause checklist:** read the stack in `pageErrors`; reproduce deterministically; confirm it's not Tauri-shell noise (the harness already filters known Tauri noise). Severity `critical` by default.

**Fix:** fix the throwing code path. Add an error boundary only where the architecture calls for graceful degradation — not as a blanket suppressor.

---

## `a11y` (axe critical/serious)

**Root-cause checklist:** read the `ruleId`, `impact`, and `selectors` from the `A11yViolation`.

**Fixes, per rule family:**
- `color-contrast` → adjust token/class to meet ratio (use the responsive Tailwind classes, not `var()` — `CLAUDE.md`).
- `button-name` / `link-name` / `image-alt` → add accessible name (`aria-label`, text, `alt`).
- `label` / `aria-*` → associate labels with controls; fix invalid ARIA.
- `list` / `heading-order` / landmarks → correct semantic structure.
- Fix the element at the attributed selector; re-run the scenario and confirm the violation is gone.

---

Once a fix lands and the metric moved, set the finding's `status` to `fixed` with `beforeAfter`. Cluster related findings under one `clusterId` for a single PR. Verification protocol and exclusions: `verification-rubric.md`.
