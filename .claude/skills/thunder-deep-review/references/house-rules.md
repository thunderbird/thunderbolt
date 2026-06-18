# House Rules (CLAUDE.md / AGENTS.md) — with rule ids

Cite the `R-*` id when surfacing a finding. Source of truth is `CLAUDE.md` (symlinked `AGENTS.md`) at repo root — read it if in doubt.

## TypeScript & style
- **R-NOANY** — never use `any` (incl. `as any`, `as unknown as`). Unsafe non-null `!` on possibly-undefined also flagged.
- **R-TYPE** — prefer `type` over `interface`.
- **R-ARROW** — prefer arrow functions over the `function` keyword.
- **R-NOLET** — prefer `const` over `let`; extract a helper with early return instead of setting a `let` inside conditionals.
- **R-CAMEL** — camelCase for consts and variables (yes, even module constants in frontend/TS). Backend JSON string values in responses may be ALL_CAPS (they are wire values, not TS identifiers) — do not flag those.
- **R-EARLY** — prefer early return over long if / nested code.
- **R-IMPORT** — direct imports (`useEffect`, not `React.useEffect`); `@/...` over deep relative paths; top-level imports over inline `await import(...)` unless a circular dep requires it.
- **R-ASYNC** — prefer async/await over `.then/.catch`.
- **R-JSDOC** — add JSDoc to new utility functions.
- **R-COMMENT** — only comment non-obvious code; remove comments that restate the next line.
- **R-NUMSEP** — numeric separators on large literals (`16_000`).
- **R-ONEFILE** — loosely one React component per file.

## React patterns
- **R-REDUCER** — use `useReducer` when a component needs 3+ `useState`. Model reducer actions as **events** (`SEARCH_STARTED`), not setters (`SET_FOO`).
- **R-STATEHOOK** — abstract state/logic into a `use[Component]State()` hook to separate computation from display and enable unit testing.
- **R-EFFECT** — treat every `useEffect` as a smell until proven necessary. **Never** use an effect for:
  - deriving state from props/state → compute during render or `useMemo`
  - syncing props into state → use the prop directly, or a ref to detect prop change during render
  - notifying parents of state changes → call the callback in the event handler
  - resetting state when a prop changes → `key` prop, or `useState` lazy initializer
  - one-time init from already-available data → `useState(() => compute())`
  - navigation side-effects → return `<Navigate replace />` in JSX
  - assigning to refs → assign `ref.current` in the render body
  - **Prefer** `useSyncExternalStore` (external stores / browser APIs), `useEffectEvent` (extract handler logic), `useOptimistic`+`useTransition`, `useTransition`, `useDeferredValue`.
  - **Legitimate** (keep): DOM listeners w/ cleanup, external subscriptions (WebSocket/SDK), DOM measurement/scroll, timers w/ cleanup, analytics, async-on-mount.
- **R-LAZY** — keep the entry bundle small. New top-level routes default to `React.lazy(() => import(...))` unless on the chat/landing critical path. Static: Chat, layouts, small auth/error pages. Lazy: all settings/admin pages, secondary features, waitlist, SSO flows. Pair lazy imports with a content-area `<Suspense>`.
- **R-VARCSS** — use standard Tailwind classes for properties with responsive theme overrides (`rounded-*`, spacing). Only use `var()` syntax for the custom variables without a Tailwind equivalent (`text-[length:var(--font-size-*)]`, `h-[var(--touch-height-*)]`, `size-[var(--icon-size-*)]`, `min-h-[var(--min-touch-height)]`).

## Data, errors, architecture
- **R-SOFTDEL** — **Frontend never hard-deletes.** Always soft-delete (`deletedAt = nowIso()`; call update APIs). Only exception: explicit account/device removal flows. Backend prefers soft-delete; hard delete only for account deletion, PowerSync DELETE ops, device revocation.
- **R-ERRSWALLOW** — prefer optimistic over defensive code. Let errors surface loudly in development; don't wrap trusted calls in try/catch that swallows. Handle errors architecturally at higher levels. Distinguish: (a) swallowing a real error → let it throw; (b) an error branch with *no* log → add `console.error`.
- **R-NODEFENSIVE** — don't add null-checks / guards against conditions that can't occur on trusted data.
- **R-DAL** — DB logic lives in the DAL (`src/dal/*`), not inline in components/settings.
- **R-HTTP** — use the app's `HttpClient` (`src/lib/http.ts`): `getHttpClient()` for authed backend calls, `http` for external APIs. No bare `fetch()`.
- **R-MIGRATION** — generate Drizzle migrations with `bun db generate`, never hand-write SQL. Always verify `backend/drizzle/meta/_journal.json` includes the new entry (else it never runs). Never `bun db push` against prod.
- **R-SYNCNULL** — new synced PowerSync columns must be nullable; adding a synced table is a two-PR deploy (backend schema + `config.yaml` sync rule + dashboard rules FIRST, frontend SECOND).
- **R-CORS** — a new custom request header needs no CORS change (echo-back), but a browser-readable response header must be added to `corsExposeHeaders`.
- **R-BUN** — use `bun` (not npm); `bun test` (not vitest); install latest (`bun add <pkg>@latest`).
- **R-SIMPLE** — bias to tasteful simplicity; avoid over-engineering, premature optimization, and defensive patterns that obscure intent. Question and recommend alternatives.

## Tests (summary — full standard in `references/testing-rules.md`)
- **R-TEST** — tests live as `<file>.test.ts` next to source and use `bun:test`; never `.spec` files, never `vitest`.
- **R-NOMOCK** — `mock.module()` of an internal/shared module is a modularity smell → prefer dependency injection (inject `httpClient`/`fetch`/`database`). Mocking is OK only for truly-external boundaries: external/auth/third-party APIs, browser APIs absent in the test env, and React Router hooks. Its stronger sibling is **`R-NOMOCKSHARED`** (a `mock.module` of a *shared* module is a blocker-tier CI-flake leak) — see `references/testing-rules.md`.
