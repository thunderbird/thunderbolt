# Firefox deep analysis — Gecko profiler over the firefox-devtools MCP

The harness treats both browsers with equal depth. But the fine-grained
attribution probes — Long Animation Frames (LoAF) and heap deltas — are built on
Chromium/CDP APIs (`scripts/lib/collect.ts` only collects `heap` when
`browserName === 'chromium'`, and LoAF via the `PerformanceObserver` LoAF entry
type is Chromium-only). So when jank is **Firefox-specific**, Playwright's
Firefox driver can *measure* it (vitals, long tasks, renders) but can't
*attribute* it to a function.

For that attribution, use the **Gecko profiler** through the connected
`firefox-devtools` MCP server. This path drives real system Firefox (v153 beta,
`/usr/local/bin/firefox`) over Marionette.

**Use this path when:** a finding reproduces on Firefox but not Chromium, or for
a Firefox-only regression, and you need to name the function responsible.

## MCP server facts

- Package `@mozilla/firefox-devtools-mcp`, launched with `--connectExisting`
  (**Firefox must already be running** with Marionette) and `--enableScript`.
- It attaches over Marionette on **port 2828** — that port must be free before
  you launch Firefox.
- Profiler tools: `mcp__firefox-devtools__profiler_start`,
  `mcp__firefox-devtools__profiler_stop`,
  `mcp__firefox-devtools__profiler_is_active`.
- Driving tools: `mcp__firefox-devtools__navigate_page`,
  `mcp__firefox-devtools__evaluate_script`,
  `mcp__firefox-devtools__click_by_uid`,
  `mcp__firefox-devtools__take_snapshot`,
  `mcp__firefox-devtools__list_network_requests`,
  `mcp__firefox-devtools__list_console_messages`,
  `mcp__firefox-devtools__screenshot_page`.

## Step-by-step

### (a) Launch system Firefox with Marionette, headless

Point it at the already-serving perf stack (`http://localhost:1431`). Use a
throwaway profile dir so nothing leaks between runs, and confirm port 2828 is
free first.

```bash
# fail fast if Marionette's port is taken
lsof -i :2828 && echo "port 2828 busy — kill the stale Firefox first" && exit 1

TMP_PROFILE="$(mktemp -d)"
/usr/local/bin/firefox --marionette --headless -profile "$TMP_PROFILE" http://localhost:1431 &
```

Leave this running for the whole session; the MCP connects to it, it does not
spawn it.

### (b) Let the MCP attach

The `firefox-devtools` server is already configured with `--connectExisting`,
so it connects to the Firefox you just launched. Confirm the attach with a
cheap call, e.g. `mcp__firefox-devtools__list_pages`.

### (c) Navigate to the scenario URL

```
mcp__firefox-devtools__navigate_page  →  http://localhost:1431<scenario.path>
```

Use the same `path` the scenario uses (see `scripts/lib/scenarios.ts`), e.g.
`/chats/new` for `chat-landing`.

### (d) Profile the exact interaction

1. `mcp__firefox-devtools__profiler_start` — use a preset suited to web/JS
   work (a **Web/JavaScript** preset: JS stacks + markers, ~1ms sampling),
   not the Media/Graphics preset.
2. Reproduce the jank. Either replay the scenario's `interact` steps via
   `mcp__firefox-devtools__evaluate_script`, or drive the concrete control with
   `mcp__firefox-devtools__click_by_uid` (get the uid from
   `mcp__firefox-devtools__take_snapshot` first). Keep the interaction short and
   identical to the reproducing scenario.
3. `mcp__firefox-devtools__profiler_stop` — returns the captured profile.

Guard with `mcp__firefox-devtools__profiler_is_active` if you're unsure whether
a prior capture is still running.

### (e) Interpret the sampled stacks and attribute the jank

- Find the **hottest stacks** during the interaction window — the leaf frames
  that accumulate the most samples are where wall-clock went.
- Read **markers** on the main thread: `Styles`, `Reflow`/`Layout`, `Paint`,
  and long `Runnable`/`JS` markers pinpoint style recalculation and layout
  (the Firefox equivalent of Chromium's `forcedStyleAndLayoutDuration`
  layout-thrash signal).
- Attribute the cost to a **function** via the leaf/self-time frame and its
  source URL. That function + file is the `sourceAttribution` for the finding.
- **Cross-check against Chromium LoAF.** Pull the same scenario's Chromium
  `loaf[].scripts[]` entry from the sweep report (`sourceURL`,
  `sourceFunctionName`, `sourceCharPosition`). If the Gecko hot frame names the
  same function, it's a shared bug — fix once, verify in both. If Chromium is
  clean and only Gecko is hot, it's a genuine Firefox-only regression; record it
  with `browsers: ['firefox']` and note the engine difference in the rationale.

## Output

Distill the profile down to a `Finding` (see [finding-schema.md](finding-schema.md)):
category `long-task` or `layout-thrash`, `browsers: ['firefox']`, `evidence`
with the ms and hot-frame self-time, and `sourceAttribution` = `file:line
function`. **Do not** attach the raw profile — the agentic layer reads only the
compact finding, consistent with the rest of the harness
([harness-tuning.md](harness-tuning.md)).
