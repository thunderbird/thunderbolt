# Testing

## Running Tests

```sh
# Run frontend tests (src/ + shared/ non-agent-core tests + selected scripts and .github script tests)
bun run test

# Run the isolated shared/agent-core module's unit tests (NOT part of `bun run test`)
bun run test:agent-core

# Build and check the production agent chunk in Chromium and WebKit (no backend/auth required)
bunx playwright install chromium webkit
bun run test:agent-core:browser

# Run frontend tests in watch mode (src/ only)
bun run test:watch

# Run backend tests
bun run test:backend

# Run backend tests in watch mode
bun run test:backend:watch

# Run end-to-end tests (Playwright)
bun run e2e
bun run e2e:headed   # with a visible browser
```

**Note**: Don't run `bun test` directly from the project root. [`bunfig.toml`](../../bunfig.toml) sets `pathIgnorePatterns = ["backend/**", "e2e/**"]`, so root discovery no longer sweeps the backend suite or the Playwright specs — but that setting is a silent no-op on Bun below 1.3.11, and a bare root run still applies no per-test timeout, no `--randomize`, and walks `shared/agent-core/`, which has its own runner (below). The `test` script uses `bun test --cwd=src` to scope discovery to the frontend tree, then runs the `shared/` test paths it enumerates (`shared/*.test.ts`, `shared/defaults/`, `shared/i18n/` — `shared/agent-core/` has its own `test:agent-core` script), `scripts/create-release.test.ts`, and the selected `.github/scripts/*.test.*` files by explicit path (`shared/` is outside `--cwd=src`, and Bun skips hidden dirs in discovery, so each path must be explicit).

**`shared/agent-core` is the app's in-browser adapter around the npm `@earendil-works/pi-agent-core` package**, not that package itself. Its nested unit tests sit outside frontend test discovery, so they are intentionally **not** part of `bun run test`. Run them with `bun run test:agent-core` (or `bun run test:agent-core:5x` for the 5x-stability gate). In CI, the dedicated `agent-core` job in [`ci.yml`](../../.github/workflows/ci.yml) runs the 5x unit gate and browser check when the module, dependencies, build configuration, browser check, or workflow changes. The CLI imports the npm Pi package directly and imports the OpenAI-compatible and confidential-model builders plus receipt lifecycle from `shared/agent-core`, unit-tested by `bun run test:agent-core`; its integration coverage remains in the CLI suite.

`test:agent-core:browser` builds into a temporary directory and imports the emitted app chunk in both engines, with native iterator helpers and with those helpers removed before import. It exercises two conversation turns through the OpenRouter, Thunderbolt, and confidential-model harness paths using injected SSE responses, then verifies OPFS data survives reload. Run this check on macOS, as the CI job does: Playwright's Linux WebKit build lacks the storage API needed for OPFS. Each case uses a fresh persistent browser profile because WebKit's ephemeral contexts reject OPFS. This is a dependency/runtime regression check, not authenticated provider or native-device coverage. To check an existing production build, set `BROWSER_TEST_DIST=/absolute/path/to/build`; the script leaves that build untouched and cleans up its own profiles.

[`vite.config.test.ts`](../../vite.config.test.ts) at the repo root is the other suite no script runs: it loads `vite.config.ts` and asserts `server.fs.strict` plus the explicit `@fs` allowlist in [`vite.config.ts`](../../vite.config.ts), the guard that keeps the dev server from serving backend source and config over `/@fs`. It is in neither the `test` script's path list nor any workflow, so run it by hand — `bun test vite.config.test.ts` — whenever you touch `server.fs`.

## Testing Guidelines

Please follow these guidelines for unit tests:

- **Prefer dependency injection over mocking to prevent test pollution.** For example, inject a custom httpClient or fetch for network requests instead of mocking them.
  - ✅ Good: `export const checkInbox = async (params, httpClient: HttpClient = http) => { ... httpClient.get(...) }` — `HttpClient` and `http` come from [`src/lib/http.ts`](../../src/lib/http.ts); inside a component, take the client from `useHttpClient()` ([`src/contexts/http-client-context.tsx`](../../src/contexts/http-client-context.tsx))
  - ❌ Bad: `mock.module('@/lib/http', () => ({ ... }))`
- **Fake timers are installed globally for all tests.** This ensures tests run quickly and deterministically.
  - Timers are automatically installed before each test and uninstalled after
  - If you need to manually advance time, use `getClock()` from `@/testing-library`:

    ```ts
    import { getClock } from '@/testing-library'

    await act(async () => {
      await getClock().runAllAsync()
    })
    ```

- **Suppress expected console errors in tests** - use `spyOn(console, 'error').mockImplementation(() => {})` in `beforeAll` for tests that intentionally trigger errors
- Always write unit tests for logic, code branching, and algorithms - these should be thoroughly covered. Unit tests for component user interactions (such as clicking or typing) are optional and might be better covered by higher-level tests (the Playwright suite in `e2e/` — see [End-to-End Tests](#end-to-end-tests)).
- Keep display logic separate from side effects and state in React components by extracting hooks. If a component has many useStates, bundle them into one state hook—this makes logic easy to test and leaves snapshot tests for checking output changes.

## Timer Management

Fake timers are automatically installed and cleaned up for each test. If you need to manually advance time within a test, use `getClock()`:

```typescript
// Wait for specific time (e.g., debounce)
await act(async () => {
  await getClock().tickAsync(300)
})

// Or settle all pending timers
await act(async () => {
  await getClock().runAllAsync()
})
```

## ⚠️ CRITICAL: Avoid `mock.module()` for Shared Modules

**Bun's `mock.module()` creates global, persistent mocks that leak across test files.** This is the #1 cause of mysterious test failures in CI where tests pass individually but fail when run together.

### The Problem

When you use `mock.module()` to mock a shared module like `@/hooks/use-settings` or `@/components/ui/dialog`, that mock persists for ALL test files running in the same worker:

```ts
// ❌ BAD: This mock will leak to other test files!
mock.module('@/hooks/use-settings', () => ({
  useSettings: () => ({ cloudUrl: { value: 'http://test' } }),
}))
```

If another test file imports `useSettings` and expects different properties (like `preferredName` or `locationName`), it will crash with errors like:

- `TypeError: undefined is not an object (evaluating 'locationName.value')`
- `SyntaxError: Export named 'DialogFooter' not found in module`

### The Solution

**Don't mock shared modules. Use real implementations with proper test setup:**

```ts
// ✅ GOOD: Use real implementations with test database
import { setupTestDatabase, teardownTestDatabase, resetTestDatabase } from '@/dal/test-utils'
import { createTestProvider } from '@/test-utils/test-provider'

beforeAll(async () => {
  await setupTestDatabase()
})

afterAll(async () => {
  await teardownTestDatabase()
})

afterEach(async () => {
  await resetTestDatabase()
})

const renderComponent = () => {
  return render(<MyComponent />, {
    wrapper: createTestProvider(),
  })
}
```

### When You Must Mock

Only mock what's truly external or necessary:

1. **External APIs** (auth services, third-party APIs)
2. **Browser APIs** that don't exist in test environment (like `window.location.reload`)
3. **React Router** hooks when testing navigation

```ts
// ✅ OK: Mocking external auth API
mock.module('@/lib/auth-client', () => ({
  authClient: {
    signIn: { magicLink: mock() },
  },
}))

// ✅ OK: Mocking React Router
mock.module('react-router', () => ({
  useNavigate: () => mockNavigate,
  useSearchParams: () => [mockSearchParams],
}))
```

### If You Absolutely Must Mock a Shared Module

If you have no choice but to mock a shared module, you **must include ALL exports** to prevent breaking other tests:

```ts
// If you must mock Dialog, include EVERY export
mock.module('@/components/ui/dialog', () => ({
  Dialog: ({ children, open }) => (open ? <div>{children}</div> : null),
  DialogClose: ({ children }) => <button>{children}</button>,
  DialogContent: ({ children }) => <div>{children}</div>,
  DialogDescription: ({ children }) => <p>{children}</p>,
  DialogFooter: ({ children }) => <div>{children}</div>,  // Don't forget this!
  DialogHeader: ({ children }) => <div>{children}</div>,
  DialogOverlay: ({ children }) => <div>{children}</div>,
  DialogPortal: ({ children }) => <div>{children}</div>,
  DialogTitle: ({ children }) => <h2>{children}</h2>,
  DialogTrigger: ({ children }) => <button>{children}</button>,
}))
```

## Helpers You Already Have

Before reaching for `mock.module()`, check [`src/test-utils/`](../../src/test-utils) — most of the cases that tempt people into a global mock already have a scoped helper. Read the list first; the "When You Must Mock" exceptions above are for what is left over.

| Module                                    | Entry points                                                                                      | Use it for                                                                                                |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `@/dal/test-utils`                        | `setupTestDatabase`, `teardownTestDatabase`, `resetTestDatabase`                                  | A real database behind the DAL, so hooks and queries run unmocked                                         |
| `@/test-utils/test-provider`              | `createTestProvider`, `createTestProviderWithCache`                                               | The whole provider stack (database, PowerSync mock, React Query, HTTP client) as a `render` wrapper       |
| `@/test-utils/powersync-mock`             | `PowerSyncMockProvider`, `createPowerSyncMockWithReactivity`                                      | PowerSync context without a database, plus a reactivity mock that replays table updates                   |
| `@/test-utils/powersync-reactivity-test`  | `renderWithReactivity`, `waitForElement`                                                          | Rendering against that reactivity mock; `waitForElement` polls the fake clock instead of `waitFor`        |
| `@/test-utils/react-query`                | `createQueryTestWrapper`, `createQueryTestWrapperWithCache`                                       | Hooks that only need a `QueryClient` (plus PowerSync/database when available)                             |
| `@/test-utils/http-client`                | `createMockHttpClient`, `mockLocationData`                                                        | An `HttpClient` that answers with canned data — inject it instead of mocking `@/lib/http`                 |
| `@/test-utils/http-client-spy`            | `createSpyHttpClient`, `jsonResponse`                                                             | Asserting on the requests a caller makes                                                                  |
| `@/test-utils/http`                       | `stubJsonResponse`                                                                                | A genuine `ResponsePromise` for `spyOn(http, 'get').mockReturnValue(...)`                                 |
| `@/test-utils/proxy-fetch`                | `mockProxyFetch`                                                                                  | A no-op `FetchFn` with the full shape, so no `as unknown as FetchFn` cast is needed                       |
| `@/test-utils/auth-client`                | `createMockAuthClient`                                                                            | A Better Auth client stand-in                                                                             |
| `@/test-utils/oauth`                      | `mockOAuthTokens`, `mockUserInfo`, `mockOAuthSuccess`, `cleanupSessionStorage`                    | OAuth callback fixtures and their session-storage cleanup                                                 |
| `@/test-utils/framer-motion-mock`         | `registerFramerMotionMock`, `animateSpy`                                                          | The one sanctioned global `framer-motion` stub — it covers every symbol so concurrent files can't collide |
| `@/test-utils/mock-intersection-observer` | `mockIntersectionObserver`                                                                        | Components gated on visibility; happy-dom's stub never fires                                              |
| `@/test-utils/mock-virtua-measurement`    | `mockVirtuaMeasurement`                                                                           | `virtua` lists, which mount nothing when every element measures 0px                                       |
| `@/test-utils/viewport`                   | `setViewport`, `forceMobileViewport`, `restoreViewport`, `desktopWidth`, `mobileWidth`            | Exercising the mobile/desktop branch of a responsive component                                            |
| `@/test-utils/console-spies`              | `setupConsoleSpy`                                                                                 | Silencing expected console output, with a `restore()` for `afterAll`                                      |
| `@/test-utils/fake-timers`                | `installFakeTimers`                                                                               | What the preload calls; in a test use `getClock()` rather than installing your own                        |
| `@/test-utils/chat-store-mocks`           | `createMockModel`, `createMockChatThread`, `createMockChatInstance`, `hydrateStore`, `resetStore` | Chat-store fixtures and a seeded/reset store                                                              |
| `@/test-utils/create-request-probe`       | `CreateRequestProbe`                                                                              | Asserting a quick-create entry point opened a surface without changing routes                             |

### What Runs Before Your Test

[`src/bunfig.toml`](../../src/bunfig.toml) preloads [`happydom.ts`](../../happydom.ts) and [`src/testing-library.ts`](../../src/testing-library.ts) before every frontend test, which is why several things work with no setup of your own:

- `happydom.ts` registers happy-dom globally and polyfills the Web Streams API.
- `src/testing-library.ts` swaps `@lingui/react/macro` and `@lingui/core/macro` for identity implementations that render the English source, so `getByText` assertions on English copy keep working with no `I18nProvider`. It also stubs the compiled `.po` catalog, which bun cannot load.
- `web-haptics/react` and `posthog-js` are already mocked there — don't re-mock them in a test file.
- Fake timers are installed and cleaned up per test, and `getClock()` is exported from `@/testing-library`.

## End-to-End Tests

The Playwright suite in [`e2e/`](../../e2e) covers what is hardest to exercise from a unit test — browser storage, redirects and Better Auth callbacks — across OIDC and SAML sign-in, the universal proxy (HTTP, WebSocket, passthrough headers, MCP), ACP agents, the language picker and its unit defaults, the minimum app-version gate, and the artifact harness.

### Projects

[`playwright.config.ts`](../../playwright.config.ts) splits the suite into four projects, and **a spec's filename decides which one it joins** — along with which servers and `baseURL` it gets:

| Project            | `testMatch`                             | `baseURL`               | Backing servers                                            |
| ------------------ | --------------------------------------- | ----------------------- | ---------------------------------------------------------- |
| `oidc`             | `/(?:oidc\|acp-\|proxy-).*\.spec\.ts$/` | `http://localhost:1421` | OIDC frontend + backend, mock OIDC IdP                     |
| `saml`             | `/saml.*\.spec\.ts$/`                   | `http://localhost:1422` | SAML frontend + backend, mock SAML IdP                     |
| `min-version-gate` | `/min-version-gate\.spec\.ts$/`         | `http://localhost:1421` | Both the ungated OIDC pair and the gated pair on 1423/8004 |
| `artifact`         | `/\/artifact-[^/]*\.spec\.ts$/`         | none                    | none — sandboxed iframes on `about:blank`                  |

Every pattern is anchored on purpose, and each anchor records a breakage:

- `.spec.ts$` keeps the non-spec files under `e2e/` (`helpers.ts`, `mock-saml-idp.ts`, `saml-test-certs.ts`) from being picked up as tests. A bare `/saml/` matched the helpers and broke `playwright test --list` with "test file should not import test file".
- The `artifact` pattern requires a leading `/` and forbids `/` inside the name so the match is the _filename_, not a worktree directory that happens to contain `artifact-`.
- The `min-version-gate` project points `baseURL` at the **ungated** frontend on 1421 so `loginViaOidc` drives the run-normally, runtime-flip and header-coverage scenarios; the hard-block scenario navigates to the gated frontend on 1423 by absolute URL and the exempt-route scenario probes the gated backend on 8004 directly.

Run one project with `bunx playwright test --project=oidc`.

### What the Config Spins Up

[`e2e/global-setup.ts`](../../e2e/global-setup.ts) starts two mock identity providers, and the config declares six web servers:

| Component                 | Port   | Notes                                                                                                                                                         |
| ------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Mock OIDC IdP             | `9876` | [`oauth2-mock-server`](https://www.npmjs.com/package/oauth2-mock-server); every issued token is signed for `sub=e2e-test-user` / `email=e2e@thunderbolt.test` |
| Mock SAML IdP             | `9877` | [`e2e/mock-saml-idp.ts`](../../e2e/mock-saml-idp.ts), with self-signed certs from [`e2e/saml-test-certs.ts`](../../e2e/saml-test-certs.ts)                    |
| OIDC frontend             | `1421` | `bun run dev -- --port 1421`, `VITE_AUTH_MODE=sso`, `VITE_SKIP_ONBOARDING=true`                                                                               |
| OIDC backend              | `8002` | `cd backend && bun run --watch src/index.ts`, `AUTH_MODE=oidc`, rate limiting off, `DATABASE_DRIVER=pglite`                                                   |
| SAML frontend             | `1422` | as above, pointed at the SAML backend                                                                                                                         |
| SAML backend              | `8003` | `AUTH_MODE=saml`, `SAML_ENTRY_POINT` at the mock IdP                                                                                                          |
| Min-version-gate frontend | `1423` | pointed at the gated backend, so its `/config` fetch returns a `minAppVersion`                                                                                |
| Min-version-gate backend  | `8004` | `MIN_APP_VERSION=99.0.0`, pinned above the build-fixed `VITE_APP_VERSION`                                                                                     |

The backends sit in the 800x band deliberately: 8002 is "off :8000 so e2e doesn't collide with `make dev`", and locally a warm e2e backend is reused across runs (`reuseExistingServer: !isCI`), which is only safe because the dev server on :8000 can never be the one reused. The gate needs its own backend because backend env is per-`webServer` and fixed for its life, so an out-of-date client cannot be simulated by flipping a variable mid-run.

Every test runs in a fresh browser context, and `use.storageState` is declared `undefined` rather than pointing at a saved sign-in state, so each spec drives the SSO flow itself and no IndexedDB / OPFS data survives from an earlier test. Both mock IdPs shut down in [`e2e/global-teardown.ts`](../../e2e/global-teardown.ts).

`workers: 1` is intentional: a CI runner already hosts several Vite and backend servers on 4 vCPUs, so a second browser worker oversubscribes the box and starves the cold first-navigation transpile. Parallelism comes from sharding instead — [`e2e.yml`](../../.github/workflows/e2e.yml) runs `--shard=1/2` and `--shard=2/2` as separate jobs with the `blob` reporter, then a follow-up job merges the blobs into a single HTML report published as the `e2e-report` artifact. The 60s per-test timeout and 10s `expect` floor exist for the same runner-speed reason.

### Helpers

`e2e/helpers.ts` keeps specs short:

- **`loginViaOidc(page)`** — navigates to `/` and waits for the chat textarea, letting `AuthGate → /sso-redirect → mock IdP → backend callback → session` complete on its own. The mock IdP auto-approves, so there's no username/password to type.
- **`loginViaSaml(page)`** — the same shape against the SAML mock IdP, which auto-generates the `SAMLResponse` and posts it to the ACS endpoint.
- **`logoutViaSidebar(page, option)`** — opens the account popover, clicks "Log out", optionally picks "Delete data from device" (`option: 'delete'`), confirms, and waits for the signed-out page.
- **`collectPageErrors(page)`** — subscribes to `pageerror` and returns an errors array, filtering Tauri-only noise (`__TAURI__`, `convertFileSrc`, etc.) that the web build surfaces harmlessly.

### Current Specs

`oidc` project:

| Spec                                                                                 | What it verifies                                                                                                                                      |
| ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`oidc-login.spec.ts`](../../e2e/oidc-login.spec.ts)                                 | Anonymous user completes the full OIDC redirect loop and lands in the chat UI, with no critical JS errors                                             |
| [`oidc-logout.spec.ts`](../../e2e/oidc-logout.spec.ts)                               | Sign-out lands on the signed-out page, can sign back in, and does not auto-reauthenticate                                                             |
| [`oidc-session.spec.ts`](../../e2e/oidc-session.spec.ts)                             | Chat UI and sidebar navigation stay functional and signed in after login                                                                              |
| [`oidc-language-picker.spec.ts`](../../e2e/oidc-language-picker.spec.ts)             | Picking a language flips `X-App-Language` without a reload, survives a reload, resets to the negotiated language, and clears on a data-wipe sign-out  |
| [`oidc-localization.spec.ts`](../../e2e/oidc-localization.spec.ts)                   | Unit defaults seed from the browser region (never falling back to US), the date-format row is retired, and unit labels re-render on a language switch |
| [`acp-built-in.spec.ts`](../../e2e/acp-built-in.spec.ts)                             | The built-in ACP adapter exposes the prompt input without errors                                                                                      |
| [`acp-add-custom-agent.spec.ts`](../../e2e/acp-add-custom-agent.spec.ts)             | Submitting the add-agent form persists a new row to the list                                                                                          |
| [`acp-system-agent-discovery.spec.ts`](../../e2e/acp-system-agent-discovery.spec.ts) | A discovered system agent appears in the System section and is not removable                                                                          |
| [`proxy-fetch.spec.ts`](../../e2e/proxy-fetch.spec.ts)                               | A GET through `/v1/proxy` carries `X-Proxy-Target-Url` and unwraps passthrough response headers                                                       |
| [`proxy-passthrough-headers.spec.ts`](../../e2e/proxy-passthrough-headers.spec.ts)   | Caller headers are wrapped as passthrough headers and the body is forwarded verbatim                                                                  |
| [`proxy-websocket.spec.ts`](../../e2e/proxy-websocket.spec.ts)                       | `createProxyWebSocket` carries the target URL as `tbproxy.target.<base64url>` on `/proxy/ws`                                                          |
| [`proxy-mcp.spec.ts`](../../e2e/proxy-mcp.spec.ts)                                   | MCP traffic routes through `/v1/proxy` with target URL and passthrough headers intact                                                                 |

`saml` project:

| Spec                                                     | What it verifies                                                              |
| -------------------------------------------------------- | ----------------------------------------------------------------------------- |
| [`saml-login.spec.ts`](../../e2e/saml-login.spec.ts)     | Anonymous user completes the full SAML redirect loop and lands in the chat UI |
| [`saml-logout.spec.ts`](../../e2e/saml-logout.spec.ts)   | Sign-out lands on the signed-out page and does not auto-reauthenticate        |
| [`saml-session.spec.ts`](../../e2e/saml-session.spec.ts) | SAML session survives navigation and the authenticated user stays signed in   |

`min-version-gate` and `artifact` projects:

| Spec                                                             | What it verifies                                                                                                                                                                                                                                                                                               |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`min-version-gate.spec.ts`](../../e2e/min-version-gate.spec.ts) | A below-min build is hard-blocked and never opens a sync stream; an at-or-above build runs ungated; the backend gate spans every route but exempts config, health, preflight and SSO callbacks; a runtime 426 raises the blocker mid-session; `X-App-Version` reaches our backend and never a proxied upstream |
| [`artifact-harness.spec.ts`](../../e2e/artifact-harness.spec.ts) | The wrapped artifact HTML reports ready plus a content height, surfaces uncaught exceptions and unhandled rejections as errors, and survives a blocked subresource                                                                                                                                             |

### Writing New Specs

- Name the file so it matches the project you want — `oidc-*`, `acp-*` or `proxy-*` for the OIDC project, `saml-*`, `min-version-gate`, `artifact-*`. A file matching none of the patterns is silently never run.
- Use `loginViaOidc(page)` or `loginViaSaml(page)` as the first line of any test that needs an authenticated user.
- Call `collectPageErrors(page)` and assert the array is empty at the end of the test to catch regressions that only surface as uncaught exceptions.
- Keep each spec scoped to a single user-visible flow. The suite is a smoke test, not a full regression matrix — favour unit tests for branching logic and rely on e2e for "does the whole thing boot".

### Debugging Mock Leakage

If you see errors like these in CI but tests pass locally:

- `Export named 'X' not found in module`
- `TypeError: X is not a function`
- `undefined is not an object`

**Check for `mock.module()` calls in recently added test files.** The culprit is usually a test file that mocks a shared module incompletely.
