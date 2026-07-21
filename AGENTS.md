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

## Route-level Code Splitting

Keep the entry bundle small by lazy-loading routes that aren't on the critical landing path. New top-level routes added to `src/app.tsx` should follow these rules:

**Static (in the entry bundle):**

- Chat (`ChatLayout`, `ChatDetailPage`) — the landing page must feel instant.
- Layouts (`SettingsLayout`, `WaitlistLayout`) — chrome around their pages. Lazy-loading a layout creates a sequential waterfall (layout chunk → page chunk) before anything paints, and the layouts themselves are tiny.
- Small auth/error pages (`MagicLinkVerify`, `OAuthCallback`, `AccountDeleted`, `SignedOut`, `NotFound`) — the per-chunk overhead exceeds their payload.

**Lazy (`React.lazy(() => import(...))`):**

- All settings/admin pages (`PreferencesSettingsPage`, `ModelsPage`, `DevicesSettingsPage`, `McpServersPage`, `IntegrationsPage`, dev-only routes).
- Secondary features (`TasksPage`, `AutomationsPage`).
- `WaitlistPage` and SSO flows (only hit by a subset of users).

When adding a new route, default to lazy unless the route is on the chat/landing critical path. Pair the lazy import with a content-area `<Suspense fallback={...}>` placed around the relevant `<Outlet />` (see `src/layout/main-layout.tsx` and `src/settings/layout.tsx`) so the sidebar/nav stays mounted while the chunk loads.

## Testing

- Create test files as `<file>.test.ts` next to source files
- Test likely edge cases, aiming for useful 80% coverage

## After Each Task

- Consider refactoring into standalone functions for clarity
- Remove unused variables and imports
- Verify tests pass and no TypeScript errors exist

## PowerSync and synced tables

See [docs/architecture/powersync-account-devices.md](docs/architecture/powersync-account-devices.md) for: synced table requirements, adding a new table (frontend + backend + schema + config.yaml + production), account deletion, device management, and backend token/revoke API.

See [docs/architecture/powersync-sync-middleware.md](docs/architecture/powersync-sync-middleware.md) for: sync data transformation middleware, custom SharedWorker (multi-tab + encryption), and adding new transformers.

See [docs/architecture/e2e-encryption.md](docs/architecture/e2e-encryption.md) for: E2E encryption architecture, key hierarchy, device approval flows, encrypted columns configuration, API endpoints, and user flows.

**Deploying new synced tables (two-PR process):**

1. **PR 1 (backend + sync rules):** Backend schema, Drizzle migration, `shared/powersync-tables.ts`, and all three sync-rule configs (`powersync-service/config/config.yaml`, `deploy/config/powersync-config.yaml`, and `deploy/k8s/templates/configmaps.yaml`). Merge → run migration → wait for `images-publish.yml` to publish the new `ghcr.io/thunderbird/thunderbolt/thunderbolt-powersync` image → **roll the Render `powersync` service to the new tag** (dashboard → Manual Deploy → Deploy latest reference).
2. **PR 2 (frontend + everything else):** Frontend schema, DAL, defaults, reconciliation, and any UI/logic. Merge only after PR 1's image is live on Render.

Deploying frontend before the sync rules are updated causes silent sync failure — the table works locally but won't replicate across devices.
See [docs/architecture/powersync-account-devices.md](docs/architecture/powersync-account-devices.md#pr-flow-for-adding-tables).

**Backend migrations checklist:** When adding a new migration, always verify that `backend/drizzle/meta/_journal.json` includes the new entry. Drizzle discovers pending migrations via the journal — if the SQL file and snapshot exist but the journal entry is missing, the migration will never run. This is easy to miss when cherry-picking migration files across branches.

**Custom SharedWorker and `@powersync/web` internal path:** `vite.config.ts` defines a `powersync-web-internal` alias pointing to `@powersync/web/lib/src` (an internal, non-public-API path). This is required for the custom `ThunderboltSharedSyncImplementation` to extend `SharedSyncImplementation`. When upgrading `@powersync/web`, verify this internal path still exists — it may break without a TypeScript error.

## Reconciled defaults and version bumps

Reconciled default tables ship a monotonic `defaults<X>Version` constant next to the defaults array. Reconciliation uses it as the ordering signal so multi-device sync groups converge without ping-ponging (see THU-637, extended to the other reconciled tables in THU-677): a device only overwrites an existing row when its defaults version is strictly newer than the highest ever applied on this account.

Files that ship a version constant today:

- `shared/defaults/models.ts` — `defaultModelsVersion`
- `src/defaults/modes.ts` — `defaultModesVersion`
- `src/defaults/tasks.ts` — `defaultTasksVersion`
- `src/defaults/skills.ts` — `defaultSkillsVersion`
- `src/defaults/settings.ts` — `defaultSettingsVersion`

`src/defaults/model-profiles.ts` is also reconciled but does not carry its own version — profiles ride the models gate (`insertMissing: true`, `canOverwrite: modelsGate.canOverwrite`), so bumping `defaultModelsVersion` covers profile changes too.

**When you change any default in one of these files, bump the version constant.** A colocated snapshot test (e.g. `shared/defaults/models.test.ts`, `src/defaults/modes.test.ts`) fails on any content change without a matching version bump and tells you exactly what to update.

## CORS and API headers

Both the main API (`backend/src/index.ts`) and the PostHog proxy route (`backend/src/posthog/routes.ts`) use `cors({ allowedHeaders: true })`, which echoes back whatever the browser requests in `Access-Control-Request-Headers`. This is required by the universal proxy at `/v1/proxy`, which forwards arbitrary upstream headers as `X-Proxy-Passthrough-*` (LLM SDKs add `x-api-key`, `x-stainless-*`, `openai-organization`, etc. — a static allowlist would break preflight whenever a new provider header appears). Adding a new custom header to any request requires no CORS-config change.

If you ever need a browser-readable response header in cross-origin code, you must add it to `corsExposeHeaders` in `backend/src/config/settings.ts` — browsers expose only the headers listed there to `Response.headers` cross-origin.

## Responsive Sizing

The project overrides Tailwind's CSS theme variables in `/src/index.css` `:root` with responsive mobile/desktop values that switch at the 768px breakpoint. Use standard Tailwind classes — **do NOT** use `var()` syntax for properties that have Tailwind equivalents.

**Standard Tailwind classes (responsive via theme overrides):**

- Border radius: `rounded-sm`, `rounded-md`, `rounded-lg`, `rounded-xl`, `rounded-2xl`, `rounded-3xl`
- Spacing: Use standard Tailwind spacing (`px-2`, `px-3`, `py-1.5`, `gap-2`, etc.)

**Border-radius tiers (concentric — pick by nesting depth, not by taste):**

- `rounded-md` — **inner**: elements nested inside a rounded parent (menu/list items, chips-in-a-card, thumbnails, skeletons, small toolbar controls)
- `rounded-lg` — **default**: standalone atoms (buttons, inputs, textareas, select triggers, badges, standalone chips/rows)
- `rounded-xl` — **container**: surfaces that wrap other content (cards, alerts, popovers, dropdown/select/menu panels, hover-cards)
- `rounded-2xl` — **hero**: blocking modals/dialogs/sheets and chat message bubbles
- `rounded-3xl` — **marquee**: the chat composer only
- `rounded-full` pills/avatars/dots · `rounded-none` flush edges

Corners step **down** as you nest (outer radius − padding ≈ inner radius): an `xl` panel with `p-1` holds `md`/`lg` children. Never hardcode px (`rounded-[12px]`), and avoid bare `rounded` and `rounded-xs` (no responsive theme override) — all three break the responsive mobile→desktop step-down. The `ui/` primitives already encode these tiers; inherit from them rather than overriding.

**Custom CSS variables (no Tailwind equivalent — use `var()` syntax):**

- Text: `text-[length:var(--font-size-body)]`, `text-[length:var(--font-size-sm)]`, `text-[length:var(--font-size-xs)]`
- Heights: `h-[var(--touch-height-default)]`, `h-[var(--touch-height-sm)]`, `h-[var(--touch-height-lg)]`, `h-[var(--touch-height-xl)]`, and `h-[var(--touch-height-control)]` (prompt-area controls)
- Icons: `size-[var(--icon-size-default)]`, `size-[var(--icon-size-sm)]`
- Minimum heights: `min-h-[var(--min-touch-height)]`
- Composer-control radius: `rounded-[var(--radius-control)]` — the one sanctioned `rounded-[var()]` exception, sized between `lg` and `xl` for the compact prompt-area controls (see the rationale in `src/index.css`). Everything else uses the named tiers above.
