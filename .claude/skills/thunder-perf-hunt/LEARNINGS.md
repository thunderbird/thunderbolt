# perf-hunt learnings log

Append one dated entry per run (newest first). Each entry records what the
REFLECT phase changed, what it proposed but did not apply, and why. See
`references/self-improve.md` for the rules. "No improvements warranted" is a
valid entry — the log should show the harness was reflected on, not that it
always changed.

Format:
```
## <YYYY-MM-DD> — run <runId> (<mode>, <browsers>)
- Applied: <safe-auto change + evidence> | none
- Proposed: <proposal + why deferred> | none
- Notes: <cost, coverage, calibration observations>
```

---

## 2026-07-06 — run 2026-07-07T02-55-44-854Z (sweep→chromium-only, chromium)
- Applied (1 SAFE-AUTO, probe fix): `scripts/lib/collect.ts` noise-render probe now returns the tree to idle (Escape + wait for no `[data-state="open"]` + 400ms settle) BEFORE `RESET_RENDERS`. Evidence: the sweep raised 107 `unnecessary-render` findings on `chat-sidebar-nav` (top `Presence` 228x, `DialogPortal` 116x — the whole Radix/framer overlay tree), all `isReal=false`. An adversarial verifier proved the scenario's 4-button-click leaves a Radix Dialog OPEN, so the probe's own `Escape` closed it and recorded the exit-animation as "idle" renders; a repeat probe from true idle gave 0 commits, matching the `chat-landing`=0 control. Post-fix focus smoke run: components with ≥3 idle commits dropped 107 → 0. tsc clean.
- Proposed (PROPOSE-ONLY, not applied):
  - **`run.ts` should persist results incrementally (per browser), not only at the very end.** This run's full sweep was hard-killed (likely OOM) during Firefox's first scenario; because `report.json` is written once at the end (run.ts:102), all 7 completed Chromium scenarios were discarded and the sweep had to be re-run Chromium-only. Writing per-browser (or per-scenario) would make a late-browser crash non-fatal. Deferred: changes run.ts control flow / adds surface — wants human review.
  - **Investigate Playwright Firefox stability/memory on this host.** Firefox died on `chat-landing` even though browsers run sequentially (Chromium closes before Firefox launches), so co-residency isn't the cause. Firefox coverage was NOT obtained this run. Deferred: needs investigation, not a one-line fix.
- Notes: Web vitals all `good` (LCP 600–1224ms, CLS ~0); no long-task (all 74–80ms, sub-threshold) or console-error findings. Real confirmed cluster: 3 axe `button-name` violations (2 high, 1 medium) → fixed in app PR #1057. After the probe fix, this sweep's dominant "finding" category evaporates entirely — the harness got materially cheaper to triage (fewer moving parts, as intended).

## 2026-07-06 — run 2 (expanded coverage: streaming + bundle + explore + firefox)
- Applied (SAFE-AUTO): (1) added a `chat-streaming-sim` BASE_SCENARIO driving the dev Message Simulator (`/message-simulator`, DEV-only) — replays canned SSE through the real streamText pipeline + production renderer, so the message-render hot path is measured with NO API key. (2) `calibration.json` excludeSignatures: suppressed the explorer's keyless-send false positives (`Ehbp-Response-Nonce`, `503 (Service Unavailable)`) — test-env artifacts, not shippable bugs.
- Validated the run-1 probe fix: re-ran the Chromium sweep with the idle-restore fix → `noiseRenders≥3` dropped 107 → 0 across all scenarios. Confirms the run-1 render storm was 100% the overlay-close artifact.
- Coverage achieved this run: Chromium sweep (7) + Firefox sweep (8, incl. streaming) + streaming focus + bundle + explore (21 states/46 transitions). **Firefox worked** when run isolated (not co-resident with Chromium) — reinforces the run-1 PROPOSE-ONLY that a full both-browser sweep OOMs on a 16GB host; keep browsers in separate runs or persist per-browser.
- Findings:
  - CONFIRMED perf: composer typing re-render cascade (chat-landing) — ~4 render passes/keystroke cascade through the closed Radix overlay/tooltip/dialog tree (Presence 136/keystroke). Verified real (3/3, linear scaling, not StrictMode, not the animation artifact). DEFERRED the fix: memoizing the two pickers zeroed them but the metric barely moved (churn is dominated by tooltips/dialogs across the whole composer, not the pickers); the real fix is isolating composer input/cursorPos state from the toolbar chrome — a risky core-input refactor for sub-ms/no-jank gain (fails CLAUDE.md no-premature-optimization). Recommend a scoped follow-up.
  - CONFIRMED bundle: entry chunk ~800KB gzip; mostly irreducible (react-dom + AI SDK chat engine + markdown + drizzle/router + static-chat), but two clean CLAUDE-compliant wins: lazy-load katex (~70KB, math-only) and defer posthog-js (~55KB, post-paint). Both are moderate refactors on hot/sensitive code (per-message markdown-math render; analytics/consent across 4 files + provider) → surfaced as reviewed recommendations, not autonomous end-of-session commits. Also a real-but-negligible (<3KB) tauri plugin-process leak into the web entry (one-file dynamic-import fix in use-desktop-update.ts).
  - Streaming hot path: HEALTHY both browsers (vitals good, 0 long tasks ≥120ms, 0 console/page errors).
  - Firefox: clean (all vitals good, no errors); LoAF/INP/longtask empty as expected (Chromium-only).
  - Sub-threshold a11y (not raised as findings): landmark-*, meta-viewport, page-has-heading-one, heading-order present on most pages (moderate impact) — noted for a future a11y pass.
- Proposed (PROPOSE-ONLY): add a realistic numeric entry-chunk budget to `analyze-bundle.ts` (~700KB) AFTER the katex/posthog wins land (400KB is unreachable given the static-chat floor). Consider surfacing high load-render commit counts during real interactions (typing), not just the idle noise probe — the typing cascade was invisible to the finding logic (idle-only).

## 2026-07-07 — run 3 (dependency slimming + bundle fixes shipped)
- Ran a dependency-slimming survey (user directive: "less deps is better; replace heavy deps with slim in-house code"). Honest headline: the codebase is ALREADY well-split — the scary big chunks (maplibre-gl 273KB, react-pdf 115KB, acorn 35KB) are all lazy and each needs a real engine → KEEP. framer-motion already uses the optimal LazyMotion+`m`+async-domMax split → KEEP. uuid (~1KB, v7 sortable IDs) / dayjs (~8KB) → KEEP.
- Shipped bundle wins (entry chunk 788.5 KB → 633.9 KB gzip, ~−154KB / ~20%), each a separate single-concern PR off main:
  - #1058 posthog-js lazy-loaded off the entry (dynamic import + in-house `usePostHogClient` context replacing posthog-js/react; `getPosthogClient()` for the alias) → −62KB. Behavior/consent/alias preserved; analytics tests pass; focus run 0 errors.
  - #1059 markdown slimming: lazy-load KaTeX (~80KB) gated per-block by the existing math regexes + drop `marked` (a 2nd tokenizer) by porting block-splitting to remark/mdast offset-slicing → −92KB. All 18 tests pass (made async for the lazy load); headless-verified math still renders. Caught+fixed a latent regex-lastIndex currency-escaping bug. Follow-up flagged: `bun remove marked && bun add unified remark-parse`.
  - #1060 tauri plugin-process/updater moved to dynamic import (desktop-only code out of web entry; kills an INEFFECTIVE_DYNAMIC_IMPORT warning). <3KB, correctness fix.
- Implementation method: two parallel sub-agents on disjoint file sets (posthog / markdown) with mandatory build-delta + test + headless-render verification, reviewed before PR. Worked well; the markdown agent self-found a real bug during its own verification.
- Deferred (documented): composer typing re-render cascade — investigated the 711-line composer; input/cursorPos state is woven through submit/token/slash/draft logic and fires on separate unbatchable DOM events; full fix = uncontrolled textarea or memoize all chrome leaves (large rewrite) for imperceptible gain → not an autonomous change.
- PROPOSE-ONLY (harness): the streaming/markdown hot-path re-render magnitude is only visible via the cumulative load-render tally, not the idle noise probe — consider a "renders during a scripted interaction" finding type. Add a numeric entry-chunk budget (~650KB now that the wins landed) to analyze-bundle.ts to prevent backsliding.

## 2026-07-07 — run 4 (round 2: confirm fixes + regression hunt on the fixed tree)
- Re-ran the full hunt on the working tree with ALL round-3 fixes applied (a11y + posthog + markdown + tauri). Result: the app is in excellent shape and the fixes introduced NO regressions.
  - Entry chunk holds at 633.9 KB gzip (from 788.5 baseline). Render storm stays 0. Every scenario both browsers: all Web Vitals good, 0 long tasks ≥120ms, 0 LoAF ≥200ms, 0 console errors, 0 page errors.
  - Specifically checked the regression my own katex lazy-load could cause: measured CLS on a math message (crafted SSE through the simulator) = 0.094 (good), and it attributed to the dev simulator page's own textarea layout, NOT the katex FOUC — so lazy KaTeX introduced no meaningful layout shift.
  - 0 shippable findings after calibration. The only raw findings were the dev-only /message-simulator a11y and the known keyless-send test-env artifacts.
- Applied (2 SAFE-AUTO harness fixes, both verified: tsc clean + focus smoke + re-report shows suppression working):
  - **explore.ts now applies calibration `excludeSignatures`** (reusing `applyExclusions`). GAP found this round: the round-3 keyless-send exclusions only filtered the perf report, so the explorer kept re-emitting the same 3 test-env artifacts. Now the crawl honors them too.
  - Added an `a11y`/`chat-streaming-sim` exclusion: that scenario targets the dev-only simulator page (tree-shaken from prod) and exists to measure streaming perf, so its axe findings aren't shipped-user concerns.
- Net: two clean rounds; harness signal is now tight (0 false positives surfacing). The harness + all its self-improvements are being committed to the repo this session (previously untracked).

## 2026-07-06 — harness authored + validated (bootstrap)
- Applied: n/a (initial build). Seeded empty `calibration.json`.
- Proposed: none.
- Notes: Validated on Chromium (vitals+attribution, 146 renders, long tasks, LoAF, network, a11y incl. a real critical `button-name`, heap delta). Known env limit: Playwright Firefox crashes on ubuntu26.04-arm64 → Firefox via the devtools MCP here. `app_init_timing` marks came back empty (init-timing.ts uses `performance.now()` snapshots, not `performance.mark`) — candidate PROPOSE-ONLY improvement if startup attribution is ever needed.
