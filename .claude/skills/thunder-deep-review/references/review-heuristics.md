# Review Heuristics — the core review intelligence

Apply these in **Pass A (Scan)**. Two parts: (1) a fast diff-signal → comment trigger table, (2) IF–THEN heuristics by category. Each heuristic, when it fires, must still pass the Pass-B verification bar (quote the line + cite a rule/invariant id) before it is surfaced.

## 1. Diff-signal → comment trigger table (scan for these literal signals)

| Diff signal | Likely finding | Rule/Cat |
|---|---|---|
| `const ALL_CAPS =` / `FOO_BAR:` keys in TS/frontend (incl. `*.config.ts`, `scripts/`, `e2e/`, `*.test.ts`) | "camelCase even for constants" | R-CAMEL |
| `let x` then reassignment; `let isX=false; if(...) isX=true` | "avoid `let` — early-return + `const`" | R-NOLET |
| `import … from '../../types'` (deep relative) | "use `@/types`" | R-IMPORT |
| `.spec.ts` file; `from 'vitest'` | "use `.test` + `bun:test`" | R-TEST |
| `mock.module(`/`vi.mock`/`jest.mock` of a SHARED module (`@/hooks/*`, `@/components/ui/*`, any app module other tests import) | "global mock leaks across files → #1 CI flake — DON'T mock shared modules; use real impls + test DB/provider" | R-NOMOCKSHARED (blocker) |
| `mock.module(`/`vi.mock`/`jest.mock` of an internal collaborator | "mocking smell → DI; or justify" | R-NOMOCK |
| partial `mock.module` of a shared module (missing exports) | "include EVERY export or it breaks the next test file" | R-NOMOCKSHARED |
| real wait in a test (`await sleep`, real `setTimeout`, `vi.useFakeTimers()`) | "fake timers are global — advance via `getClock()` in `act()`" | R-FAKETIMERS |
| `spyOn(console,'error')` in a test that triggers an expected error | OK — prescribed pattern, NOT error-swallowing (do not flag) | R-SUPPRESSCONSOLE |
| backend route test that module-mocks the db/`fetch` instead of `createApp({ database, fetchFn })` + `createTestDb()` | "inject via DI; roll back in `afterEach` `cleanup()`" | R-DITEST |
| Component with 3+ `useState(` | "switch to `useReducer`" | R-REDUCER |
| useState + useEffect that syncs/derives from props/state | "derive during render, don't effect" | R-EFFECT |
| `useEffect(` with no adjacent justifying comment | "justify the effect or remove" | R-EFFECT |
| reducer with `SET_FOO`/`SET_BAR` actions | "actions = events (SEARCH_STARTED), not setters" | R-REDUCER |
| Second backend route duplicating `/chat`/`/inference` per provider | "fold into the one canonical endpoint" | architecture |
| `if (model === 'mistral')`, hardcoded `google`/`microsoft` in generic code | "stay integration-agnostic — data column/config" | architecture |
| Hardcoded array listing every model / every table name | "list will grow & bloat — derive it" | bloat |
| `React.lazy` missing on a settings/admin/enterprise/OIDC route in `app.tsx` | "lazy-load — bundle + attack surface" | R-LAZY |
| New `dependencies` entry (esp. docx/pdf parsers); unpinned `^` | "supply-chain + bundle risk; pin" | bloat |
| Backend route handler with no auth/session guard; denylist arrays | "require auth; allowlist > denylist" | security |
| `rateLimit` keyed by IP on an authenticated route | "per-user, not per-IP" | security |
| Literal IPs, owned domains, home paths, seeded UUIDs in migrations/tests | "use example.com / 1.1.1.1; regen UUIDs" | security |
| Template-string building HTML/widget tags w/o escape; `sandbox="… allow-popups"` | "escape attrs; tighten sandbox" | security |
| `db.delete()` / hard delete on user-data tables (frontend) | "must soft-delete (`deletedAt`)" | R-SOFTDEL |
| Non-nullable column added to a synced table schema | "synced cols must be nullable; confirm two-PR deploy" | INV / sync |
| Migration SQL added without `_journal.json` entry | "journal entry missing — migration never runs" | INV-55 |
| DB query/mutation inline in a component/settings file | "move into `dal.ts`" | architecture |
| `catch (e) { console.warn(...) }` and continue; OR error branch with no logging | "let it throw" / "at least `console.error`" | R-ERRSWALLOW |
| `setTimeout`/`requestAnimationFrame` near init/race/flicker | "don't paper over the race; fix the branching" | error-handling |
| New `use[X]()`/wrapper with 1–2 call sites | "premature abstraction — inline it" | simplicity |
| Comment restating the next line (`// Save X` above `saveX()`) | "remove — self-explanatory" | R-COMMENT |
| `as any` / `as unknown as`; non-null `!` on possibly-undefined | "avoid the cast / unsafe assertion" | R-NOANY |
| switch/if over enum/db-type with no throwing `default` | "add throwing `default` — would silently fail" | error-handling |
| Prompt strings the code then string-matches on exact wording | "brittle; breaks across languages/providers" | llm |
| dev-env/CI/playwright/prettier churn intermixed with feature | "separate PR" | scope |
| `bun.lock`/`package.json`/workflow churn unrelated to PR title | "intentional?" | scope |
| Recomputed value a hook already provides (`?? 'http://localhost:8000/v1'` next to `useSettings()`) | "the hook already does this" | simplicity |
| Numeric literal `16000` without separators | "use `16_000`" | R-NUMSEP |
| Single-row setter/getter called in a loop | "plural batch variant — one SQL query" | perf |
| `useQuery` result assumed complete (no pagination) | "anticipate scale; lazy single SQL lookup" | perf |
| Hardcoded config (domain/cloudUrl/CORS) where app self-hosts | "should be env-driven" | architecture |
| Verbose user copy ("This action cannot be undone.") | "trim to minimal clear phrasing" | ux |
| Same list duplicated in a `.md` doc and source | "don't store twice — link" | docs |

## 2. IF–THEN heuristics by category

### Architecture & coupling (highest value)
- IF a diff adds a route/endpoint paralleling an existing canonical one THEN ask if it folds into the existing endpoint so cross-cutting hooks (token tracking, auth, observability) stay centralized — flag the second path.
- IF new logic branches on a specific model/provider/integration THEN push the knowledge into data (a models-table column, config object, or tool/system-prompt instruction) so it survives those becoming plugins.
- IF DB validation/guard logic (soft-delete, `isSystem`) lives in a bespoke helper THEN move it into the DAL.
- IF a cross-cutting concern (auth, prompt-injection sanitization) is enforced per-route THEN push it to the single enforcement point.
- IF a general-purpose function gains feature-specific logic THEN flag the coupling; generalize or move it out.
- IF new code reimplements an existing primitive (memoize, platform helpers, debounce, `useQuery`, dayjs, a localStorage hook) THEN redirect to the existing one.
- IF placeholder/temporary code lands THEN require it be named temporary and point at the eventual home.

### Abstraction altitude
- IF a new hook/wrapper/util/config-object wraps a single call site or trivial values THEN challenge as premature — inline it ("the value doesn't justify the complexity").
- IF the same expression/logic recurs 3+ times THEN extract a named helper — but only on genuine recurrence.
- IF code is "janky/funky/hacky" (mutating a function after it runs, re-throwing to control flow) THEN flag it as a smell and ask for the clean structure.

### Error handling
- IF an error is caught and downgraded to `console.warn`/silent return on a path that shouldn't fail THEN "let it throw so we can fix it" (anti-defensive).
- IF an error/early-return branch has NO logging THEN require at least `console.error`/`console.warn` ("some future debugger gets burned"). (Distinguish from the swallow case.)
- IF a switch/if over an enum/db-type has no throwing `default` THEN flag silent-failure on a future variant.
- IF a race/ordering/flicker bug is "fixed" with `setTimeout`/`rAF`/extra state THEN reject as masking the real branching bug.
- IF code is defensive against an impossible condition on trusted data THEN call it overly defensive; prefer loud failure, fix upstream.

### Testability — full standard in `references/testing-rules.md`
- IF a test `mock.module()`s a **SHARED** module (`@/hooks/*`, `@/components/ui/*`, or any app module other tests import) THEN it is a **blocker** (`R-NOMOCKSHARED`): the mock leaks globally across every test file in the worker — the #1 cause of CI failures that pass alone but fail together (`Export named 'X' not found`, `undefined is not an object`). Don't tell them to mock it better — tell them to **stop mocking shared modules** and use real impls + a test DB/provider. This is NOT just a DI taste nit; press it as a CI-flake blocker.
- IF a test partial-mocks a shared module (omits some exports) THEN flag it (`R-NOMOCKSHARED`): a missing export breaks the next test file — include EVERY export if a shared-module mock is truly unavoidable.
- IF a test relies on heavy mocking (esp. `mock.module` of internal collaborators) THEN modularity smell → DI (`R-NOMOCK`/`R-DITEST`), or at minimum a comment why the mock is unavoidable. Mocking is OK only for truly-external things: external/auth/third-party APIs, browser APIs absent in the test env, and React Router hooks — do NOT flag those.
- IF a backend route test module-mocks the db or `fetch` THEN redirect to DI (`R-DITEST`): inject via `createApp({ database, fetchFn })` + `createTestDb()`, and roll back in `afterEach` via `cleanup()`.
- IF a test uses a real wait (`await sleep`, real `setTimeout`) or re-installs timers (`vi.useFakeTimers()`) THEN flag (`R-FAKETIMERS`): fake timers are installed globally — advance time via `getClock()` (`tickAsync`/`runAllAsync`) inside `act()`.
- IF a test intentionally triggers an error THEN it should `spyOn(console,'error').mockImplementation(() => {})` in `beforeAll` (`R-SUPPRESSCONSOLE`). **Do NOT flag this as error-swallowing** — it is the OPPOSITE of the production `R-ERRSWALLOW` rule; in a test it is the prescribed pattern, not a smell.
- IF branchy logic (parsers, `prepareStep`, reconciliation, `getOrCreate`) lacks unit tests THEN request tests; suggest extracting a pure function.
- IF a test uses `.spec`/`vitest` or `as any`/`as unknown as` THEN flag (`R-TEST`/`R-NOANY`).

### Correctness
- IF you find a genuine bug (nullable-sync, error-before-first-assistant-message, off-by-one branch) THEN label it explicitly "real bug" and distinguish from nits.
- IF logic depends on the LLM emitting exact wording THEN flag brittleness (non-English/cross-provider); prefer a structural fix.

### Security / privacy / data / perf
- IF a backend endpoint is added without auth/session THEN ask whether it needs a session; prefer allowlist over denylist.
- IF rate-limiting is per-IP on an authed route THEN suggest per-user.
- IF code embeds PII, an owned domain, a real IP, or seeded UUIDs THEN flag (use `example.com`, `1.1.1.1`, regenerate UUIDs).
- IF model/external output is interpolated into HTML/widget attrs THEN require escaping; tighten over-broad `sandbox`.
- IF a delete touches user data THEN require soft-delete unless it is explicit account/device removal.
- IF a new synced PowerSync column is non-nullable THEN flag sync-breaking; confirm the two-PR deploy.
- IF a single-row setter/getter is called in a loop THEN suggest a plural batch variant.
- IF a `useQuery` result is assumed complete THEN anticipate scale; flag missing pagination.
- IF config is hardcoded but the app self-hosts/enterprise/standalone THEN ask whether it should be env-driven.

### Docs-intent / completeness / scope
- IF a magic constant/flag/reference appears with no explanation THEN ask what it is / require a justifying comment (the "what is this?" catch).
- IF a change handles one case but sibling cases exist THEN ask "should the others be handled too?" (completeness).
- IF a path is inconsistent with a sibling path THEN flag the inconsistency.
- IF a PR mixes unrelated changes THEN recommend splitting; call out incidental lockfile/version churn ("intentional?").
- IF a real-but-out-of-scope concern surfaces THEN defer with a follow-up (Linear) rather than blocking.

## 3. Deep correctness checklist (run line-by-line on every changed hunk)

Correctness is the largest bucket of real findings and the easiest to skim past. For each changed hunk, trace the data flow and check **every** item:

- **Wrong/duplicated variable in a payload or branch** — e.g. an event sends `new_position` and `old_position` both from `updates[0].order` (delta always 0); a copy-pasted object reuses the wrong field.
- **Defaulting operator** — `a || b` where `a` can be a *valid* `0`/`''`/`false` → should be `a ?? b`.
- **Unsafe assertion** — `x!` or `x as T` on a value that can be `undefined`/`null` here.
- **Unguarded index** — `arr[0]` / `lookup(...)[0]` without checking the array is non-empty (`dns.lookup`, `.filter()[0]`, query `.rows[0]`).
- **Redundant optional chaining** — `?.` on something always defined (`.all()` always returns an array; a `= []`-defaulted destructure) → dead/ misleading code.
- **Exact-equality where a range/set is meant** — `=== '127.0.0.1'` misses `127.0.0.0/8`; a single host check that should be CIDR/range; an enum compared to one literal where several apply.
- **Dead / unreachable branch & dead defensive guard** — `if (value)` / `if (x)` where `x` cannot be falsy at that point; a branch whose condition is impossible (`isAnonymous && !isAuthenticated`).
- **Missing throwing `default`** — `switch`/if-chain over an enum or db-type with no `else`/`default` that throws → silent failure on a future variant.
- **Missing-guard on external/IO result** — DNS, fetch, db row, JSON parse used without handling the empty/error case.
- **Body/size/pagination limits** — a proxy/handler that reads a request body or `useQuery` result with no size cap / pagination → unbounded.
- **Return-contract change** — a function that changed from `Promise<T|null>` to a raw query builder (or dropped an `await`) → callers now mishandle it.
- **Non-deterministic ordering** — `ORDER BY` / `.sort()` on a non-unique key with no tiebreak.
- **Recursion / N+1** — recursive id/descendant collection that can blow the stack or fire N queries → prefer iterative BFS / one query.
- **Async hygiene** — `.then/.catch` where the codebase uses async/await; fire-and-forget async whose rejection is silently dropped (await it, or it's an error-swallow).
- **Brittle string/keyword matching** — logic that depends on the LLM/user emitting exact wording (breaks across languages/providers); an over-broad regex (a generic self-closing-tag matcher that also eats real HTML).
- **Hardcoded-true / redundant property** — a field set to a constant (`has_coordinates: true`) that's always that value → redundant; flag it.
- **Token/length confusion** — a `token_count` computed from `.length` (characters), not a tokenizer → wrong; rename or remove.

## 4. Docs-intent, naming & micro-quality (high-frequency, easy to skim past)

- **Undocumented marker / magic reference** — an internal tracking code or magic string leaked into a comment or constant with no explanation (`external-6`, `external-14`, `M3`, `M4`, a bare flag). Ask "what is this?" — one finding per distinct marker.
- **Typos in user-facing or doc strings** — e.g. "privacy police" → "privacy policy".
- **Docs placement / completeness** — telemetry/feature docs buried in README that belong in a dedicated file; a "how to add X" checklist that omits a now-required step (update the doc, add the telemetry); a list duplicated in a doc and source.
- **Naming** — boolean not prefixed `is/should/has`; a vague name (`variables` → `updated`); a misleading word (`bypassed` where "disabled" is meant); a name implying the wrong flow (`confirmation` email vs `joined-waitlist`).
- **Unnecessary wrapper / indirection** — a one-line function wrapping `import.meta.env.X` → reference it directly; a `deps` object bundling args that read cleaner flat.
- **Safety defaults** — a permissive flag (`AUTH_ALLOW_ANONYMOUS`) that should default to `false` in code, not just in `.env.example`.
- **Single-source config** — a hardcoded `from` address / client constructed per-file that should live once in a shared module and be imported.
