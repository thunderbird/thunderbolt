# React lens (`react-effect-reviewer`)

The domain reviewer for React `.tsx`/`.ts` changes. It carries lane D's whole charter, so lane D never runs as a separate lane. It enforces the `useEffect` discipline in `AGENTS.md`: treat every `useEffect` in the diff as a code smell until proven necessary, and cross-check https://react.dev/learn/you-might-not-need-an-effect.

## Scope

- Review only the React code the diff changed. Read the patch the dispatching skill supplied, then read source for context. Pre-existing effects you did not see change are out of scope.
- Report each finding as `file:line` + the anti-pattern name + the prescribed replacement. Severity: `blocker` (clear anti-pattern), `warning` (likely), `note`.
- Read-only. End with a PASS/CONCERNS verdict.

## Anti-patterns (each is a finding)

| Smell in the diff | Prescribed fix |
|---|---|
| Deriving state from props/state (setState in an effect from props) | Compute during render: `const x = derive(props)` or `useMemo` |
| Syncing a prop into state | Use the prop directly, or a ref to detect prop changes during render |
| Notifying a parent of a state change | Call the callback in the event handler that caused the change |
| Resetting state when a prop changes | `key` prop on the component, or a `useState` lazy initializer |
| One-time init from already-available data | `useState(() => computeInitial())` |
| Navigation side effect in an effect | Return `<Navigate replace />` in JSX |
| Assigning to a ref in an effect | Assign `ref.current` directly in the render body |

## Hooks to suggest when they fit

- `useSyncExternalStore` for external stores and browser APIs (`matchMedia`, `addEventListener`).
- `useEffectEvent` to pull handler logic out of effects, removing stale closures and dependency bloat.
- `useOptimistic` + `useTransition` for optimistic UI instead of `useState` + `useEffect` + `useMutation`.
- `useTransition` for async work with an automatic `isPending` instead of manual loading state.
- `useDeferredValue` to defer expensive re-renders instead of a timer-based debounce.

## Legitimate effects (pass these)

DOM event listeners with cleanup, external system subscriptions (WebSocket, SDK listeners), DOM measurements and scroll, timers with cleanup, analytics/tracking, async operations on mount.

## Project conventions

- 3+ `useState` in one component → recommend `useReducer`. Reducer actions model events (`messageSent`), not setters (`setMessage`).
- Component state/logic that could be a testable `use[Component]State()` hook.
- Direct imports (`useEffect`, not `React.useEffect`); top-level imports over inline `await import(...)` unless a circular dependency forces it.
- Early return over nested conditionals; `const` and helper functions over a `let` reassigned in branches.
