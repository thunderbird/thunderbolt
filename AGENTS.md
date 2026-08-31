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

- All settings/admin pages (`PreferencesSettingsPage`, `ModelsPage`, `DevicesSettingsPage`, `ConnectionsPage`, dev-only routes).
- Secondary features (`TasksPage`, `AutomationsPage`).
- `WaitlistPage` and SSO flows (only hit by a subset of users).

When adding a new route, default to lazy unless the route is on the chat/landing critical path. Pair the lazy import with a content-area `<Suspense fallback={...}>` placed around the relevant `<Outlet />` (see `src/layout/main-layout.tsx` and `src/settings/layout.tsx`) so the sidebar/nav stays mounted while the chunk loads.

## Testing

- Create test files as `<file>.test.ts` next to source files
- Test likely edge cases, aiming for useful 80% coverage
- **Never run bare `bun test` at the repo root** — it discovers every `*.test.*` file in the repo, including `backend/` tests that open real connections (test DB, WebSocket e2e) and hang forever without their services running, and it applies no timeout. Use `bun run test` (scoped to `src/` + `shared/` with a 5s per-test timeout, finishes in ~15s), `bun test <path> --timeout 5000` for a specific file/folder, or `bun run test:backend` for backend tests

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

**FTS search index couples to PowerSync's internal tables:** `src/search/fts-setup.ts` builds the unified `search_index` (THU-766) by attaching SQLite triggers to PowerSync's internal backing tables (`table.internalName`, i.e. `ps_data__*` / `ps_data_local__*`) and reading their JSON `data` blob via `json_extract(data, '$.<snake_case_column>')`. Both the table naming and the blob layout are undocumented `@powersync/web` implementation details. A PowerSync upgrade that renames or restructures them breaks search **silently** — no TypeScript error, and often no runtime error (the index just goes empty/stale). When upgrading `@powersync/web`, verify the internal table names and `data` blob shape still hold. The trigger-count self-heal in `createSearchIndex` (rebuilds when the expected triggers are missing) mitigates PowerSync dropping/recreating those tables at runtime, but not a shape change; bump `searchIndexVersion` to force a rebuild when the registry or FTS schema changes.

**FTS tokenization is deliberately locale-independent:** the index is built with `tokenize = 'unicode61 remove_diacritics 2'` and nothing in `src/search/` reads the app locale. The index holds *user content*, whose language is independent of the UI language and routinely mixed within one account, so keying the tokenizer on the locale would be wrong for most rows — and a language change must never rebuild the index. Scripts unicode61 cannot tokenize (Japanese, Chinese, Thai, Lao, Khmer, Myanmar) are matched with `LIKE` at query time instead, routed per term by `src/search/query-plan.ts`; a parallel `trigram` index was measured and rejected (~2.2× the source text in extra storage, and it silently drops terms shorter than three characters from a MATCH). The porter stemmer was removed — it indexes stems while queries append a `*` prefix, so prefixes longer than the stem stopped matching and the palette blanked out mid-word. `src/search/fold.ts` mirrors the tokenizer's folding in JS so `highlight.tsx` marks what actually matched; both use locale-independent case folding on purpose.

## Reconciled defaults and version bumps

Reconciled default tables ship a monotonic `defaults<X>Version` constant next to the defaults array. Reconciliation uses it as the ordering signal so multi-device sync groups converge without ping-ponging (see THU-637, extended to the other reconciled tables in THU-677): a device only overwrites an existing row when its defaults version is strictly newer than the highest ever applied on this account.

Files that ship a version constant today:

- `shared/defaults/models.ts` — `defaultModelsVersion`
- `src/defaults/tasks.ts` — `defaultTasksVersion`
- `src/defaults/skills.ts` — `defaultSkillsVersion`
- `src/defaults/settings.ts` — `defaultSettingsVersion`

`src/defaults/model-profiles.ts` is also reconciled but does not carry its own version — profiles ride the models gate (`insertMissing: true`, `canOverwrite: modelsGate.canOverwrite`), so bumping `defaultModelsVersion` covers profile changes too.

**When you change any default in one of these files, bump the version constant.** A colocated snapshot test (e.g. `shared/defaults/models.test.ts`, `src/defaults/skills.test.ts`) fails on any content change without a matching version bump and tells you exactly what to update.

## CORS and API headers

Both the main API (`backend/src/index.ts`) and the PostHog proxy route (`backend/src/posthog/routes.ts`) use `cors({ allowedHeaders: true })`, which echoes back whatever the browser requests in `Access-Control-Request-Headers`. This is required by the universal proxy at `/v1/proxy`, which forwards arbitrary upstream headers as `X-Proxy-Passthrough-*` (LLM SDKs add `x-api-key`, `x-stainless-*`, `openai-organization`, etc. — a static allowlist would break preflight whenever a new provider header appears). Adding a new custom header to any request requires no CORS-config change.

If you ever need a browser-readable response header in cross-origin code, you must add it to `corsExposeHeaders` in `backend/src/config/settings.ts` — browsers expose only the headers listed there to `Response.headers` cross-origin.

## App version gate

The backend enforces a minimum app version via `createAppVersionMiddleware` (mounted globally in `backend/src/index.ts`). It is a no-op until `MIN_APP_VERSION` is set; when set, every `/v1` request from a below-minimum client gets a **426 Upgrade Required** unless its path is in `appVersionExemptPrefixes` (`backend/src/middleware/app-version.ts`). The gate is **fail-closed** — a missing `X-App-Version` header is rejected on non-exempt routes.

- **Adding a backend route hit by a browser redirect or a header-less client** (OAuth/SSO callbacks, WebSocket upgrades, posthog-js, CLI device-grant) — add its prefix to `appVersionExemptPrefixes`, or it will 426 silently once the gate is enabled.
- **Adding a frontend→backend fetch client** — route it through `appVersionHeader()` (`src/lib/app-version.ts`) so it sends `X-App-Version`. The universal proxy adds the header to the outer hop only; it must never leak to external upstreams (see `skipHeaders` in `src/lib/proxy-fetch.ts`).
- **Passing per-call headers to a Better Auth method** (`authClient.signIn.emailOtp({ fetchOptions: { headers } })`) — Better Auth **replaces** the client-level headers instead of merging them, so a bare `headers` object silently drops `X-App-Version` and the call 426s on a perfectly current build. Build it with `authRequestHeaders()` (`src/contexts/auth-context.tsx`) instead.
- Enabling the gate is a config change (`MIN_APP_VERSION`), not a deploy. `getSettings()` memoizes per process, so **restart the backend** after changing it.

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

## Localization (i18n)

The app runs on Lingui v6 with `.po` catalogs in `src/locales/{locale}/messages.po`. The message id is the English source text, so **there are no keys to invent** — write the copy, run `bun run i18n:extract`, and commit the catalogs. CI (`bun run i18n:check`) fails if they are stale.

**Every user-facing string goes through a macro.** That includes `aria-label`, `title`, and `placeholder` — a translated UI with English screen-reader labels is a half-finished job.

```tsx
import { Trans, useLingui } from '@lingui/react/macro'

<h1><Trans>Not Found</Trans></h1>              // JSX text
<button aria-label={t`Go back`} />             // string position; t from useLingui()
```

Pick by position: `<Trans>` for anything rendered as JSX (it handles inline elements and interpolation), and `` t`…` `` from `useLingui()` for values that must be strings.

**Never build a sentence from fragments.** One message per sentence, values as placeholders — `` t`Deleted ${name}` ``, not `'Deleted ' + name`. Word order differs across languages, so a joined fragment is untranslatable.

### Module scope freezes the locale

`` t`…` `` resolves against the catalog active _where it is evaluated_. At module scope that is import time, so the string pins to the boot locale and never follows a language change. One rule covers every case: **module scope declares `` msg`…` `` descriptors; the point of use resolves them with `i18n._(descriptor)`.**

- **Constant tables** (error copy, option labels) hold descriptors and the render site resolves them. See `src/lib/otp-error-messages.ts`.
- **Zod schemas and other builders** become factories taking `i18n: I18n`, called during render. See `src/components/onboarding/onboarding-name-step.tsx`. Don't reach for `useMemo` — `i18n` is a stable singleton, so the only usable dependency is `i18n.locale`, which `exhaustive-deps` rejects as redundant.

Do **not** pass `t` into a helper to work around this. The extractor only recognises a macro it can see imported in the file, so a `t` arriving as a parameter produces no catalog entry — the string silently never reaches translators, and nothing fails to tell you.

Resolving eagerly in an async event handler — `i18n._(getOtpErrorMessage(...))` before storing the result in state — is fine and deliberate: the snapshot is taken while the user is looking at the screen. Use the `i18n` singleton there rather than `useLingui()`, which would imply a reactivity the stored string doesn't have.

### Formatting dates, numbers, and durations

Every rendered date, relative time, number, and duration goes through `src/i18n/format.ts`. Components call `useFormatters()`; non-React callers call `getFormatters(getActiveLocale())`.

```tsx
const formatters = useFormatters()
formatters.relativeTime(device.lastSeen) // "2 hours ago" / "vor 2 Stunden" / "2 時間前"
formatters.compactNumber(usedTokens) // "256K" / "256.000" / "25.6万"
formatters.duration(reasoningTime) // "1.5s" / "1,5s" / "1.5s"
formatters.time(start, { hour12 }) // "1:30 PM" / "13:30" / "午後1:30"
```

`duration` is the one place the layer does not let CLDR name the unit. `unitDisplay: 'narrow'` for
seconds is not stable across ICU builds — the same code renders German as `1,5s` on ICU 74 and
`1,5 Sek.` on ICU 78 — so only the number is localized and `s`/`ms` are appended as SI symbols.
Never pin CLDR-derived output in a doc, a JSDoc example, or an assertion; assert the behaviour
under test (the decimal separator here) instead of the suffix.

**Never format inline.** A bare `Intl.NumberFormat('en', …)` pins English; a bare `value.toLocaleString()` silently uses the _host_ locale rather than the app's. Both bugs shipped before THU-809.

**The hook is not optional.** Lingui's `I18nProvider` re-renders only components that read its context, so a component formatting off a module-level `getActiveLocale()` keeps rendering the outgoing locale after a language switch. `useFormatters()` subscribes via `useActiveLocale()`; `getFormatters` is memoized per locale, so its result is referentially stable and safe in a dependency array.

**Parse through `toDate`, never `new Date(str)`.** `new Date('2026-08-26')` is UTC midnight, so a bare `YYYY-MM-DD` renders as the previous day anywhere west of Greenwich. `toDate` gives date-only strings an explicit local midnight.

**No date library.** `Intl` carries full CLDR, so a new locale needs no code. Pattern-based formatters (dayjs, date-fns) can't replace it: the pattern is ours and encodes English word order — `format('dddd, MMM D')` yields "Mittwoch, Aug. 26" in German, where CLDR gives "Mittwoch, 26. Aug.".

`time` takes `hour12` explicitly rather than defaulting to the locale's convention, because the choice is the user's `time_format` setting — an en-US user preferring 24-hour is the whole point of having it. Everything else the layer renders is locale-derived, so nothing else takes an override. `temperature_unit` is a unit _conversion_ rather than a format and stays with the weather widget.

Expect output to vary more than English suggests: German and Japanese don't abbreviate thousands, so `256K` becomes `256.000` and `25.6万`. Assertions on formatted output should pin the locale — `getFormatters('en')` — rather than rely on negotiation. `bun test` runs in UTC, so hardcoded day-of-month expectations are stable there but not in the browser.

### Units and their defaults

Four synced settings describe how the user wants quantities shown: `distance_unit`, `temperature_unit`, `time_format`, `currency`. Their values are derived from CLDR, keyed on an ISO 3166-1 alpha-2 region.

```ts
unitDefaultsForRegion('GB')
// { distanceUnit: 'imperial', temperatureUnit: 'c', timeFormat: '24h', currency: 'GBP' }
```

**Distance and temperature are separate CLDR categories.** `measurementSystem` puts US and LR on `US` and GB and MM on `UK`; `measurementSystem-category-temperature` is a different list — US, BS, BZ, KY, PR, PW — and explicitly overrides LR and MM back to metric. Britain is imperial for road distance and Celsius for weather, and modelling the two as one field is what made the retired `units-by-country.json` wrong on eight regions. `src/i18n/region-units.ts` transcribes both lists plus a region→currency map from `cldr-json`; refresh them from upstream when a country changes currency.

**Hour cycle is computed, never stored — but the tag must carry no script subtag.** ICU keys its hour-cycle data on `language-REGION`, so a maximized tag falls off the lookup path and silently resolves to the root default: `en-GB` is `h23` while `en-Latn-GB` is `h12`, and `es-MX` is `h12` while `es-Latn-MX` is `h23`. `tagForRegion` drops the script for this reason and has a regression test on GB and MX.

**Defaults are seeded, not fetched.** `useUnitDefaults` (mounted beside `useAppLanguage` in `app.tsx`) writes each unset setting with `recomputeHash`, exactly as the `language` setting is seeded — so reconcile's `wouldOverwriteUserValue` guard preserves it, a reset means "back to auto", and two devices cannot ping-pong the synced rows. The region comes from `location_country_code`, then the first `navigator.languages` tag carrying a region, then the app locale. The middle step matters: the app ships one `en` catalog for every English-speaking region, so a British user resolved through the locale alone would maximize to `US`.

Judge seedability **per setting**, not across the group — a user who picks a currency by hand should still get distance, temperature and time seeded.

**Write groups of settings with `updateSettings(db, { … })`, not several `setValue` calls.** Each `setValue` opens its own transaction and SQLite rejects a `begin` while one is open, so `Promise.all` over four of them fails three. Sequential awaits work but leave the group non-atomic.

**Option labels come from `useUnitLabels()`**, never from the stored token. Names that `Intl` has no API for — "Metric", "Imperial", "Celsius", "Fahrenheit" — are `msg` descriptors; symbols come from `Intl.NumberFormat` with `unitDisplay: 'short'`. Not `narrow`: English narrows Fahrenheit to a bare `°`, and Japanese and Portuguese spell "mile" out in full. Currency names use `Intl.DisplayNames` and symbols come from `formatToParts`, which is locale-dependent (pt-BR writes USD as `US$`).

**Never resolve a region from a country name.** `location_country_code` is written from the geocoding provider's own `country_code`, which it returns independently of the request language. The display name in `location_name` localizes; the code does not.

**`date_format` is retired** (THU-810). CLDR already knows each locale's date pattern, and the three patterns the setting offered were a strictly worse subset. Existing rows are left in place, unmanaged.

### Constraints

- **No `select` / `selectOrdinal`.** The `po-gettext` catalog format cannot express them (see the rationale in `lingui.config.ts`). Plurals use `<Plural>` / `plural()`, which map to native gettext plural forms.
- **Don't reword while extracting.** The English source _is_ the id, so a copy edit orphans its translations — and 30 Playwright selectors in `e2e/` match on English text. Copy changes belong in their own commit.
- **Thrown Errors stay English; the display boundary translates.** Localizing internal control flow buys nothing. Code-mapped user copy (`otp-error-messages.ts`) is display, not control flow, and is translated.
- **Model-facing text stays English**: widget contracts in `src/widgets/*/instructions.ts`, skill instructions, system prompts, and the citation/widget schema messages. One language means no translation drift in behaviour-critical prompts.
- **Dev-only surfaces are excluded** in `lingui.config.ts` (`src/devtools/**`, `src/settings/dev-settings.tsx`).
- **`label`/`description` on synced default rows** (skills, tasks, automations, agents, models) are reconciled by content hash — translating them breaks reconciliation across devices. Leave them alone; THU-811 owns that problem.

### Verifying

Switch Settings → Localization to **Pseudo-locale (en-XA)**, available in dev builds only. Anything still rendering plain English was missed. Bun tests need no provider: `src/testing-library.ts` mocks the macros with identity implementations that render the English source, so `getByText` assertions keep working.
