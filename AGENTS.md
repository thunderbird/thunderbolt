## Core Principles

- **Bias towards tasteful simplicity** - favor elegant, readable, maintainable solutions that add minimal complexity. Avoid over-engineering, premature optimization, and defensive coding patterns that obscure intent.
- **Always implement proper, architectural solutions** - no shortcuts, hacky fixes, or temporary workarounds. Research best practices when needed.
- **Prefer optimistic code over defensive code** - let errors surface loudly during development rather than wrapping everything in if-checks and try/catch blocks. Handle errors architecturally at higher levels (e.g., error handling middleware).
- **Deletes (soft vs hard)**
  - **Frontend**: Never hard delete. Always soft delete data (set `deletedAt`; call APIs that update rather than permanently remove). The only exception is flows that explicitly perform account or device removal (e.g. “Delete account”), which call backend endpoints that hard delete by design.
  - **Backend**: Prefer soft deletes—set `deletedAt` and filter out soft-deleted records in queries. Use hard delete only when required: e.g. account deletion (user and related data), PowerSync delete operations, or other cases where permanent removal is by design.
- **Question and recommend alternatives** - your goal is better outcomes, not blind execution. Stop and ask for input when appropriate.

## TypeScript & Code Style

- Never use `any` in TypeScript
- Prefer `type` over `interface`
- Prefer arrow functions over `function` keyword
- Prefer `const` over `let` - create helper functions with early return instead of setting `let` variables inside conditionals
- Use camelCase for const and variable names
- Prefer early return over long if statements and nested code
- Use direct imports: `useEffect` not `React.useEffect`
- Prefer top-level imports over inline/dynamic imports (`await import(...)`) when no circular dependency exists
- Prefer async/await over .then/.catch
- Add JSDoc comments to new utility functions
- Only comment non-obvious code - avoid useless comments like "// Save data collection mutation" before `saveDataCollection()`
- Loosely prefer one React component per file

## Tooling & Libraries

- Use `bun` instead of `npm`
- Use `bun test` instead of `vitest`
- Install latest versions: `bun add <package>@latest`
- Use the app's `HttpClient` (`src/lib/http.ts`) instead of bare `fetch` — use `getHttpClient()` for authenticated backend calls, `http` for external APIs
- Generate Drizzle migrations with `bun db generate` - never manually create SQL files
- Never manually run `git add`, `git commit`, or `git push` — always use `/thunderpush`
- Use `resolve-library-id` and `get-library-docs` tools for library documentation (if unavailable, request access)

## React Patterns

- Use `useReducer` when a component needs 3+ `useState` hooks
- Abstract state/logic into `use[Component]State()` hooks to separate computation from display logic and enable unit testing

### `useEffect` Discipline

**Treat every `useEffect` as a code smell until proven necessary.** Before writing or reviewing a `useEffect`, consult https://react.dev/learn/you-might-not-need-an-effect and verify it doesn't match a known anti-pattern.

**Never use `useEffect` for:**
- **Deriving state from props/state** — compute during render: `const x = derive(props)` or use `useMemo`
- **Syncing props into state** — use the prop directly, or use a ref to detect prop changes during render
- **Notifying parents of state changes** — call the callback in the event handler that caused the change
- **Resetting state when a prop changes** — use a `key` prop on the component, or a `useState` lazy initializer
- **One-time initialization from already-available data** — use `useState(() => computeInitial())` lazy initializer
- **Navigation side effects** — return `<Navigate replace />` in JSX
- **Assigning to refs** — assign `ref.current` directly in the render body

**Prefer these hooks over `useEffect` when applicable:**
- `useSyncExternalStore` — for subscribing to external stores, browser APIs (`matchMedia`, `addEventListener`)
- `useEffectEvent` — to extract handler logic out of effects, eliminating stale closures and dependency bloat
- `useOptimistic` + `useTransition` — for optimistic UI updates instead of `useState` + `useEffect` + `useMutation`
- `useTransition` — for wrapping async operations with automatic `isPending` instead of manual loading state
- `useDeferredValue` — for deferring expensive re-renders instead of timer-based debounce

**Legitimate `useEffect` uses** (keep these): DOM event listeners with cleanup, external system subscriptions (WebSocket, SDK listeners), DOM measurements/scroll, timers with cleanup, analytics/tracking, async operations on mount.

## Testing

- Create test files as `<file>.test.ts` next to source files
- Test likely edge cases, aiming for useful 80% coverage

### Testability through design, not mocks

**Treat mocking/spying as a last resort.** The first question when something is hard to test should be "how can I restructure this code to be testable without mocks?" — not "how do I mock this dependency?"

**Preferred approaches (in order):**
1. **Pure functions** — extract logic into pure functions that take inputs and return outputs. Test those directly.
2. **Dependency injection** — pass dependencies as parameters with sensible defaults (see `useOAuthConnect`'s `OAuthDependencies` pattern). Tests provide test implementations without any mocking framework.
3. **`spyOn`** — when you must intercept an external module's behavior, use `spyOn(module, 'export')` in `beforeEach` and `mock.restore()` in `afterEach`. Unlike `mock.module`, spies are properly restorable.
4. **`mock.module`** — absolute last resort, only for external modules (Tauri plugins, platform APIs) that cannot be injected. Never for project code.

### `mock.module` rules (when unavoidable)

Bun runs all test files in a single process with a shared module cache. `mock.module()` permanently mutates the global cache — `mock.restore()` does NOT undo it ([oven-sh/bun#7823](https://github.com/oven-sh/bun/issues/7823)). This means partial mocks poison every test file that runs afterward. [PR #26546](https://github.com/oven-sh/bun/pull/26546) may fix this — until it merges, these rules are mandatory.

**Mandatory rules when using `mock.module`:**
- **Always mock ALL exports** — never provide a partial mock. A mock missing `getDeviceDisplayName` will cause `SyntaxError: Export named 'getDeviceDisplayName' not found` in unrelated test files.
- **Use the shared mock helpers** in `src/test-utils/`:
  - `webPlatformMock` / `desktopPlatformMock` from `platform-mock.ts` for `@/lib/platform`
  - `tauriCoreMock` from `tauri-mock.ts` for `@tauri-apps/api/core`
- **Spread and override** — `mock.module('@/lib/platform', () => ({ ...webPlatformMock, isTauri: () => true }))`
- **Guard defensively** — if your test imports a module that another test file mocks, add your own `mock.module` guard at the top of your file to ensure correct behavior regardless of execution order.
- **Place `mock.module` before all imports** of the mocked module — bun hoists mocks but the mock must be registered before the module is first loaded.

## After Each Task

- Consider refactoring into standalone functions for clarity
- Remove unused variables and imports
- Verify tests pass and no TypeScript errors exist

## PowerSync and synced tables

See [docs/architecture/powersync-account-devices.md](docs/architecture/powersync-account-devices.md) for: synced table requirements, adding a new table (frontend + backend + schema + config.yaml + production), account deletion, device management, and backend token/revoke API.

See [docs/architecture/powersync-sync-middleware.md](docs/architecture/powersync-sync-middleware.md) for: sync data transformation middleware, custom SharedWorker (multi-tab + encryption), and adding new transformers.

See [docs/architecture/e2e-encryption.md](docs/architecture/e2e-encryption.md) for: E2E encryption architecture, key hierarchy, device approval flows, encrypted columns configuration, API endpoints, and user flows.

**Deploying new synced tables (two-PR process):**

1. **PR 1 (backend-only):** Backend schema, Drizzle migration, `shared/powersync-tables.ts`, and `config.yaml` sync rule. Merge → run migration → update PowerSync Cloud dashboard rules.
2. **PR 2 (frontend + everything else):** Frontend schema, DAL, defaults, reconciliation, and any UI/logic. Merge only after PR 1's dashboard rules are live.

Deploying frontend before the sync rules are updated causes silent sync failure — the table works locally but won't replicate across devices.
See [docs/architecture/powersync-account-devices.md](docs/architecture/powersync-account-devices.md#pr-flow-for-adding-tables).

**Backend migrations checklist:** When adding a new migration, always verify that `backend/drizzle/meta/_journal.json` includes the new entry. Drizzle discovers pending migrations via the journal — if the SQL file and snapshot exist but the journal entry is missing, the migration will never run. This is easy to miss when cherry-picking migration files across branches.

**Custom SharedWorker and `@powersync/web` internal path:** `vite.config.ts` defines a `powersync-web-internal` alias pointing to `@powersync/web/lib/src` (an internal, non-public-API path). This is required for the custom `ThunderboltSharedSyncImplementation` to extend `SharedSyncImplementation`. When upgrading `@powersync/web`, verify this internal path still exists — it may break without a TypeScript error.

## CORS and API headers

When adding new custom headers to API requests (e.g. `X-Device-ID`, `X-Device-Name`), update `backend/src/config/settings.ts` so `corsAllowHeaders` includes them. Otherwise CORS preflight will fail and requests from the browser will be blocked.

## Responsive Sizing

The project overrides Tailwind's CSS theme variables in `/src/index.css` `:root` with responsive mobile/desktop values that switch at the 768px breakpoint. Use standard Tailwind classes — **do NOT** use `var()` syntax for properties that have Tailwind equivalents.

**Standard Tailwind classes (responsive via theme overrides):**
- Border radius: `rounded-sm`, `rounded-md`, `rounded-lg`, `rounded-xl`, `rounded-2xl`
- Spacing: Use standard Tailwind spacing (`px-2`, `px-3`, `py-1.5`, `gap-2`, etc.)

**Custom CSS variables (no Tailwind equivalent — use `var()` syntax):**
- Text: `text-[length:var(--font-size-body)]`, `text-[length:var(--font-size-sm)]`, `text-[length:var(--font-size-xs)]`
- Heights: `h-[var(--touch-height-default)]`, `h-[var(--touch-height-sm)]`, `h-[var(--touch-height-lg)]`, `h-[var(--touch-height-xl)]`
- Icons: `size-[var(--icon-size-default)]`, `size-[var(--icon-size-sm)]`
- Minimum heights: `min-h-[var(--min-touch-height)]`
