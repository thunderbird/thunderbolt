# State exploration — curiosity-driven crawler

`scripts/explore.ts` is the harness's functional bug-finder. Where the scenario
sweep (`scripts/run.ts`) drives a fixed list of routes to measure performance,
the explorer *wanders* the app to find things that are simply broken: uncaught
errors, console errors, crashes, dead-ends, and unexpected navigations to
`/not-found`.

It runs against the same Docker-free anonymous stack as the sweep (frontend
`:1431`, backend `:8010` — see `scripts/lib/env.ts`) and reuses a warm stack if
one is already serving.

## Live state graph, not random clicking

Monkey-testing fires random inputs at random coordinates. The explorer instead
builds a **live state graph** and picks its next move from what it can actually
see:

- **State key** = current URL + a signature of the visible interactive elements
  (roles + accessible names of buttons, links, inputs, tabs, menu items). Two
  screens that expose the same affordances collapse to the same node, so the
  crawler doesn't re-explore cosmetically-different-but-equivalent states.
- **Edges** = actions taken (click this button, fill this field, open this menu)
  and the state they led to.
- **Frontier** = the set of interactive elements in the current state that the
  crawler has *not* yet exercised. Each step it picks an unvisited action,
  performs it, snapshots the resulting state, and adds a new node/edge.

Because every action is informed by observed state, the crawl is *directed*:
it prefers unexplored affordances, backtracks out of dead-ends, and stops
revisiting equivalent screens. This finds real reachable bugs far faster than
random input, and every bug comes with the exact path that produced it.

## What counts as a functional bug

Each step evaluates the resulting state and emits a `Finding` (see
[finding-schema.md](finding-schema.md)) when it observes any of:

- **Uncaught page error** — `pageerror` fired (Tauri noise filtered as in
  `scripts/lib/collect.ts`). Category `crash`, severity `critical`.
- **Console error** — an `error`-level console message. Category
  `console-error`.
- **Crash / blank state** — the page has no visible `main`/`[role=main]` content
  after the action settles, or the render tree threw.
- **Dead-end** — an interactive element that leads nowhere (no state change, no
  navigation, no network) where a transition was expected.
- **Unexpected `/not-found`** — navigation landed on the not-found route from an
  in-app affordance (a broken link/route).

## Every finding carries a full repro

A functional finding is only useful if a human or a verifier sub-agent can
reproduce it. Each one records:

- **Click path** — the ordered list of actions from the entry route to the
  failing state (e.g. `/chats/new → click "Settings" → click "Devices" → click
  "Revoke"`). This is the `repro` field.
- **Evidence** — the error message, console text, or the "expected a transition,
  got none" note, with numbers where relevant.
- **Screenshot** — the per-state PNG captured at the moment of failure, written
  under the run's `explore/` directory.

## Visual diffing of per-state screenshots

The explorer screenshots every distinct state. On a `--mode diff` run it
compares each state's screenshot against the baseline (previous run or main)
for the same state key. A pixel/region delta above threshold becomes a
`Finding` even when the DOM assertions all pass — this catches UI regressions
that are invisible to structural checks: clipped layouts, z-index/overlap
regressions, missing icons, color/contrast shifts, off-screen content. Pair
this with the axe pass (see [a11y-checks.md](a11y-checks.md)) for structural vs.
visual coverage.

## Cost bounds

The crawl is capped at **~60 distinct states** by default so cost stays
bounded — the state-collapsing key is what makes this cap meaningful (60
*unique* screens, not 60 clicks). When the cap is hit the crawler stops and
reports coverage.

- Raise the budget with `--steps <n>` for a deeper crawl.
- Scope the crawl with `--focus <route>` to explore a subtree.
- Prefer running the explorer only on `--mode sweep` / nightly, not on every
  quick diff run — see [harness-tuning.md](harness-tuning.md) for when to skip
  it.

The explorer, like every probe, writes only compact `Finding` JSON — never raw
traces — so the agentic layer reads a small artifact. See
[finding-schema.md](finding-schema.md) for the on-disk layout.
