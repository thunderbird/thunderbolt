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

## Localization (i18n)
Most of these fail *silently* — only in production, or only after a language switch — so they need a reviewer rather than a test.
- **R-I18NMACRO** — every user-facing string goes through a Lingui macro: `<Trans>` for JSX, `` t`…` `` from `useLingui()` (`@lingui/react/macro`) for string positions. That **includes `aria-label`, `title` and `placeholder`** — a translated UI with English screen-reader labels is half-finished. Exempt: dev-only surfaces excluded in `lingui.config.ts` (`src/devtools/**`, `src/settings/dev-settings.tsx`), thrown `Error` messages (internal control flow), and model-facing text (widget `instructions.ts`, skill instructions, system prompts) which stays English on purpose.
- **R-I18NMODSCOPE** *(blocker)* — **no `` t`…` `` at module scope.** `t` resolves against the catalog active where it is *evaluated*, so at module scope it pins to the boot locale and never follows a language change. Module scope declares `` msg`…` `` descriptors; the point of use resolves them with `i18n._(descriptor)` (see `src/lib/otp-error-messages.ts`). Zod schemas and other builders become factories taking `i18n: I18n`, called during render. Also flag **`t` passed into a helper as a parameter** — the extractor only recognises a macro it can see imported in the file, so the string never reaches the catalog and nothing warns.
- **R-I18NFORMAT** — dates, relative times, numbers and durations go through `src/i18n/format.ts`: `useFormatters()` in components, `getFormatters(getActiveLocale())` elsewhere. Flag any inline `new Intl.NumberFormat('en', …)` (pins English) or bare `value.toLocaleString()` (silently uses the *host* locale, not the app's) — both shipped as bugs before THU-809. A component reading a module-level `getActiveLocale()` instead of the hook keeps rendering the outgoing locale after a switch, because `I18nProvider` only re-renders context readers.
- **R-I18NDATE** — parse with `toDate` from `src/i18n/format.ts`, never `new Date(str)`. A bare `YYYY-MM-DD` is UTC midnight and renders as the previous day anywhere west of Greenwich.
- **R-I18NPLURAL** — no `select` / `selectOrdinal`. The `po-gettext` catalog format cannot express them (rationale in `lingui.config.ts`); plurals use `<Plural>` / `plural()`, which map to native gettext plural forms.
- **R-I18NFRAGMENT** — one message per sentence, values as placeholders (`` t`Deleted ${name}` ``, not `'Deleted ' + name`). Word order differs across languages, so a joined fragment is untranslatable. Also flag a **copy edit to existing English source text** mixed into a feature change: the English source *is* the message id, so rewording orphans its translations (and `e2e/` selectors match on English text).
- **R-I18NEMAIL** *(blocker)* — **never import `@lingui/*/macro` anywhere under `backend/src/`**. Bun has no Babel pass, so the macro resolves to Lingui's stub and throws; `backend/eslint.config.js` bans the group across its whole `src/**/*.{ts,tsx}` scope, not just the email templates — those are simply where backend prose lives. Backend copy uses the plain runtime `i18n._({ id: 'English text' })`, and per-locale instances come from `getEmailI18n(locale)` (`backend/src/emails/i18n.ts`) — never a module-global `i18n.activate()`, which would leak one concurrent request's language into another's email. The recipient locale comes from the `X-App-Language` header via `resolveEmailLocale`; a server-side `auth.api.sendVerificationOTP` call must pass that header explicitly (and *only* that header) or the email silently falls back to English.

## Tests (summary — full standard in `references/testing-rules.md`)
- **R-TEST** — tests live as `<file>.test.ts` next to source and use `bun:test`; never `.spec` files, never `vitest`.
- **R-NOMOCK** — `mock.module()` of an internal/shared module is a modularity smell → prefer dependency injection (inject `httpClient`/`fetch`/`database`). Mocking is OK only for truly-external boundaries: external/auth/third-party APIs, browser APIs absent in the test env, and React Router hooks. Its stronger sibling is **`R-NOMOCKSHARED`** (a `mock.module` of a *shared* module is a blocker-tier CI-flake leak) — see `references/testing-rules.md`.
