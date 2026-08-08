# React re-render playbook

How the harness counts renders, how to read the numbers without being misled, and how to fix an unnecessary-render finding in a way that fits this codebase's rules (`CLAUDE.md`). Every fix here ends the same way: **re-run the focus scenario and show `commits` dropped.**

## How the render counter works

`INIT_SCRIPT` (in `scripts/lib/inject.ts`) plants a **minimal `__REACT_DEVTOOLS_GLOBAL_HOOK__` shim before React loads**. React detects the hook and calls `onCommitFiberRoot` after every commit. The shim walks the committed fiber tree from `root.current`:

- For each fiber with a numeric `actualDuration > 0` (i.e. it did render work this commit), it reads the component name (`displayName` / `name`, unwrapping `memo`/`forwardRef` via `type.render`). Host elements (`div`, `span`) are skipped.
- It tallies per component into `RenderStat`: `commits` (count), `totalDuration` (summed `actualDuration`), `maxDuration`.

Results are exposed via `READ_SNAPSHOT` sorted by `commits` desc. `store.commits` is the total commit count across the whole app.

### Load-bearing caveat: `actualDuration` is subtree-inclusive

**A parent fiber's `actualDuration` includes the time of every child it re-rendered.** So a high `totalDuration` on a top-level component (e.g. `<App>`, a layout, a provider) often just means "a lot rendered underneath it," not "this component is expensive." Do **not** rank findings by duration.

**Use `commits` as the primary signal** — "how often does this component re-render." A leaf that commits 12 times during a no-op is a real problem; a root that commits twice with a large `totalDuration` is usually fine. Duration is a secondary tiebreaker for two components with similar commit counts.

## The noise-render probe

This is the harness's cheap unnecessary-render detector, feeding `noiseRenders` in each `ScenarioReport`.

1. Warm the route (Vite compiles on first hit — an unwarmed route pollutes the measurement).
2. `RESET_RENDERS` — zero all counters (`__resetRenders()`).
3. Perform an interaction **unrelated to any component's data**: a mouse move over empty chrome, an `Escape` keypress, or a `wheel` scroll on a non-scrolling region. Nothing about app state should legitimately change.
4. Read the snapshot. Any component that committed **≥ 3 times** (`NOISE_RENDER_MIN_COMMITS`) during that no-op is a strong unnecessary-render candidate.

`report.ts` raises those as `unnecessary-render` findings: `commits ≥ 8` → `high`, else `medium`; confidence `medium` (a real interaction could legitimately touch some components — hence the verification gate). The idea: if a no-op interaction causes a component to re-render 3+ times, something is subscribing it to churn it has no business reacting to.

## The precise oracle: react-scan

The noise probe finds suspects cheaply; **react-scan confirms and pinpoints them.** Run it as a complementary check:

```bash
bunx react-scan@latest <url>
```

It instruments renders and reports exactly which components re-rendered, why (which prop/state/context changed), and how often — the "why" the noise probe can't give you. Use it to attribute a candidate to a specific unstable prop or context before writing a fix.

## Fix catalog (each mapped to a `CLAUDE.md` rule)

Pick the fix by **cause**, not by symptom. Confirm the cause with react-scan first.

| Cause | Fix | Rule |
| --- | --- | --- |
| **Unstable object / array / function prop** — a new `{}`, `[]`, or inline `() => …` created every parent render | Wrap in `useMemo` / `useCallback`, or hoist the constant out of the component entirely | Prefer stable references; avoid re-creating on every render |
| **Context value churns** — provider passes a fresh object each render, re-rendering every consumer | Memoize the value (`useMemo`), or split one context into stable + volatile halves so consumers subscribe only to what they use | Abstract state into hooks; don't over-subscribe |
| **Derived state recomputed in a `useEffect`** that setStates → extra commit | Compute during render (`const x = derive(props)` or `useMemo`) — delete the effect | useEffect discipline: never derive state in an effect |
| **Prop synced into state via effect** | Use the prop directly, or a ref to detect changes during render | useEffect discipline: never sync props into state |
| **Parent re-render cascades into stable leaves** | `React.memo` the leaf (with stable props — see row 1), or move the churning state down so it doesn't sit above the leaves | useReducer / state-down; keep state at the lowest useful level |
| **List re-renders whole list on any change** | Stable `key`s (never array index for reorderable lists) + virtualization for long lists; memoize row components | One component per file; keep renders cheap |
| **Reset-on-prop via effect** | Use a `key` prop to remount, or a `useState` lazy initializer | useEffect discipline: reset via `key` |

### Anti-patterns to avoid in the fix

- Do **not** wrap everything in `useMemo`/`useCallback` reflexively — memoization has a cost and obscures intent. Memoize only the reference that react-scan proved is churning. (`CLAUDE.md`: tasteful simplicity, no premature optimization.)
- Do **not** add a `useEffect` to "fix" a render loop — that usually adds a commit. The render-time / event-handler / `key` alternatives above are the architectural fix.
- Do **not** suppress the symptom with `React.memo` on a component whose props are still unstable — memo with unstable props re-renders anyway. Fix the prop first.

## Proving the fix

A render finding is only `fixed` when the number moved. After the change:

1. Re-run the exact focus scenario: `bun scripts/run.ts --mode focus --focus <scenario> --browsers <browser>`.
2. Read `noiseRenders` (and/or re-run react-scan) for the target component.
3. Record `beforeAfter` on the `Finding`: `{ metric: 'commits', before, after, unit: 'commits' }`. The component should now commit below `NOISE_RENDER_MIN_COMMITS` during the no-op.

If commits didn't drop, the cause was misdiagnosed — go back to react-scan. See `verification-rubric.md` for what the separate verifier requires, and note the exclusions there: **re-renders during active AI streaming and StrictMode double-renders in dev are expected and auto-refuted** — don't chase them.
