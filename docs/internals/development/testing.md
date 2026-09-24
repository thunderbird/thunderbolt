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

**Never run `bun test` from the project root.** [`bunfig.toml`](../../../bunfig.toml)'s `pathIgnorePatterns = ["backend/**", "e2e/**"]` keeps root discovery off the backend suite and the Playwright specs, but is a silent no-op on Bun below 1.3.11, and a root run has no per-test timeout, no `--randomize`, and walks `shared/agent-core/` (own runner).

`bun run test` is `bun test --cwd=src` plus explicit paths: `shared/*.test.ts`, `shared/defaults/`, `shared/i18n/`, `scripts/create-release.test.ts`, selected `.github/scripts/*.test.*`. They must be explicit: `shared/` is outside `--cwd=src`, and Bun skips hidden dirs.

### `shared/agent-core`

The app's in-browser adapter around the npm `@earendil-works/pi-agent-core` package, not that package itself. Its nested unit tests sit outside frontend discovery, so they are intentionally **not** in `bun run test`.

- `bun run test:agent-core` (or `test:agent-core:5x` for the stability gate) runs the unit tests. CI's `agent-core` job in [`ci.yml`](../../../.github/workflows/ci.yml) runs the 5x gate and browser check when the module, dependencies, build configuration, browser check, or workflow changes.
- The CLI imports the npm Pi package directly, plus the OpenAI-compatible and confidential-model builders and receipt lifecycle from `shared/agent-core`. Its integration coverage stays in the CLI suite.

`test:agent-core:browser` builds into a temp directory, imports the emitted chunk in both engines (with and without native iterator helpers), runs two turns through the OpenRouter, Thunderbolt and confidential-model harness paths on injected SSE responses, then checks OPFS data survives reload. It is a dependency/runtime regression check, not authenticated-provider or native-device coverage.

- Run it on macOS, as CI does: Playwright's Linux WebKit build lacks the storage API for OPFS.
- Each case uses a fresh persistent profile; WebKit's ephemeral contexts reject OPFS.
- `BROWSER_TEST_DIST=/absolute/path/to/build` checks an existing build, untouched, cleaning up its own profiles.

### `vite.config.test.ts`

[`vite.config.test.ts`](../../../vite.config.test.ts) is the other suite no script or workflow runs. It asserts [`vite.config.ts`](../../../vite.config.ts) keeps `server.fs.strict` and the explicit `@fs` allowlist, the guard against serving backend source and config over `/@fs`. Run `bun test vite.config.test.ts` by hand whenever you touch `server.fs`.

## Testing Guidelines

- **Prefer dependency injection over mocking**, which pollutes other tests. Inject an httpClient or fetch rather than mocking the network module.
  - ✅ `export const checkInbox = async (params, httpClient: HttpClient = http) => { ... httpClient.get(...) }`, with `HttpClient` and `http` from [`src/lib/http.ts`](../../../src/lib/http.ts). In a component, take the client from `useHttpClient()` ([`src/contexts/http-client-context.tsx`](../../../src/contexts/http-client-context.tsx)).
  - ❌ `mock.module('@/lib/http', () => ({ ... }))`

- **Fake timers are installed and cleaned up per test.** Advance them with `getClock()` (see [Timer Management](#timer-management)).
- **Suppress expected console errors** with `spyOn(console, 'error').mockImplementation(() => {})` in `beforeAll`.
- **Always unit-test logic, branching, and algorithms.** Tests for component interactions (clicking, typing) are optional, often better covered by [End-to-End Tests](#end-to-end-tests).
- **Extract hooks** so display logic stays separate from side effects and state. Bundle many `useState`s into one state hook: logic becomes testable and snapshots only check output.

## Timer Management

```typescript
import { getClock } from '@/testing-library'

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

**Bun's `mock.module()` creates global, persistent mocks that leak across test files.** The #1 cause of tests that pass alone but fail together in CI.

### The Problem

Mocking a shared module such as `@/hooks/use-settings` or `@/components/ui/dialog` affects ALL test files in the same worker.

```ts
// ❌ BAD: This mock will leak to other test files!
mock.module('@/hooks/use-settings', () => ({
  useSettings: () => ({ cloudUrl: { value: 'http://test' } }),
}))
```

Another file importing `useSettings` and expecting `preferredName` or `locationName` crashes with:

- `TypeError: undefined is not an object (evaluating 'locationName.value')`
- `SyntaxError: Export named 'DialogFooter' not found in module`

### The Solution

Real implementations, with a test database:

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

Only external APIs (auth, third-party), browser APIs missing in the test environment (`window.location.reload`), and React Router hooks when testing navigation.

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

Include **ALL exports**, or you break other tests:

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

Check [`src/test-utils/`](../../../src/test-utils) first; most cases that tempt people into a global mock have a scoped helper.

| Module                                    | Entry points                                                                                      | Use it for                                                                                               |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `@/dal/test-utils`                        | `setupTestDatabase`, `teardownTestDatabase`, `resetTestDatabase`                                  | A real database behind the DAL, so hooks and queries run unmocked                                        |
| `@/test-utils/test-provider`              | `createTestProvider`, `createTestProviderWithCache`                                               | The whole provider stack (database, PowerSync mock, React Query, HTTP client) as a `render` wrapper      |
| `@/test-utils/powersync-mock`             | `PowerSyncMockProvider`, `createPowerSyncMockWithReactivity`                                      | PowerSync context without a database, plus a reactivity mock that replays table updates                  |
| `@/test-utils/powersync-reactivity-test`  | `renderWithReactivity`, `waitForElement`                                                          | Rendering against that reactivity mock; `waitForElement` polls the fake clock instead of `waitFor`       |
| `@/test-utils/react-query`                | `createQueryTestWrapper`, `createQueryTestWrapperWithCache`                                       | Hooks that only need a `QueryClient` (plus PowerSync/database when available)                            |
| `@/test-utils/http-client`                | `createMockHttpClient`, `mockLocationData`                                                        | An `HttpClient` that answers with canned data; inject it instead of mocking `@/lib/http`                 |
| `@/test-utils/http-client-spy`            | `createSpyHttpClient`, `jsonResponse`                                                             | Asserting on the requests a caller makes                                                                 |
| `@/test-utils/http`                       | `stubJsonResponse`                                                                                | A genuine `ResponsePromise` for `spyOn(http, 'get').mockReturnValue(...)`                                |
| `@/test-utils/proxy-fetch`                | `mockProxyFetch`                                                                                  | A no-op `FetchFn` with the full shape, so no `as unknown as FetchFn` cast is needed                      |
| `@/test-utils/auth-client`                | `createMockAuthClient`                                                                            | A Better Auth client stand-in                                                                            |
| `@/test-utils/oauth`                      | `mockOAuthTokens`, `mockUserInfo`, `mockOAuthSuccess`, `cleanupSessionStorage`                    | OAuth callback fixtures and their session-storage cleanup                                                |
| `@/test-utils/framer-motion-mock`         | `registerFramerMotionMock`, `animateSpy`                                                          | The one sanctioned global `framer-motion` stub; it covers every symbol so concurrent files can't collide |
| `@/test-utils/mock-intersection-observer` | `mockIntersectionObserver`                                                                        | Components gated on visibility; happy-dom's stub never fires                                             |
| `@/test-utils/mock-virtua-measurement`    | `mockVirtuaMeasurement`                                                                           | `virtua` lists, which mount nothing when every element measures 0px                                      |
| `@/test-utils/viewport`                   | `setViewport`, `forceMobileViewport`, `restoreViewport`, `desktopWidth`, `mobileWidth`            | Exercising the mobile/desktop branch of a responsive component                                           |
| `@/test-utils/console-spies`              | `setupConsoleSpy`                                                                                 | Silencing expected console output, with a `restore()` for `afterAll`                                     |
| `@/test-utils/fake-timers`                | `installFakeTimers`                                                                               | What the preload calls; in a test use `getClock()` rather than installing your own                       |
| `@/test-utils/chat-store-mocks`           | `createMockModel`, `createMockChatThread`, `createMockChatInstance`, `hydrateStore`, `resetStore` | Chat-store fixtures and a seeded/reset store                                                             |
| `@/test-utils/create-request-probe`       | `CreateRequestProbe`                                                                              | Asserting a quick-create entry point opened a surface without changing routes                            |

### What Runs Before Your Test

[`src/bunfig.toml`](../../../src/bunfig.toml) preloads [`happydom.ts`](../../../happydom.ts) and [`src/testing-library.ts`](../../../src/testing-library.ts) before every frontend test:

- `happydom.ts`: happy-dom globally, plus a Web Streams polyfill.
- `src/testing-library.ts`: identity implementations of `@lingui/react/macro` and `@lingui/core/macro` that render the English source, so `getByText` works with no `I18nProvider`. It also stubs the compiled `.po` catalog, which bun cannot load.
- `web-haptics/react` and `posthog-js` are mocked there already. Don't re-mock them in a test file.
- Fake timers are installed and cleaned up per test; `getClock()` is exported from `@/testing-library`.

## End-to-End Tests

The Playwright suite in [`e2e/`](../../../e2e) covers what a unit test cannot: browser storage, redirects and Better Auth callbacks. See [Current Specs](#current-specs) for coverage.

### Projects

[`playwright.config.ts`](../../../playwright.config.ts) splits the suite into four projects, and **a spec's filename decides which one it joins**, along with its servers and `baseURL`. Run one with `bunx playwright test --project=oidc`.

| Project            | `testMatch`                             | `baseURL`               | Backing servers                                            |
| ------------------ | --------------------------------------- | ----------------------- | ---------------------------------------------------------- |
| `oidc`             | `/(?:oidc\|acp-\|proxy-).*\.spec\.ts$/` | `http://localhost:1421` | OIDC frontend + backend, mock OIDC IdP                     |
| `saml`             | `/saml.*\.spec\.ts$/`                   | `http://localhost:1422` | SAML frontend + backend, mock SAML IdP                     |
| `min-version-gate` | `/min-version-gate\.spec\.ts$/`         | `http://localhost:1421` | Both the ungated OIDC pair and the gated pair on 1423/8004 |
| `artifact`         | `/\/artifact-[^/]*\.spec\.ts$/`         | none                    | none, sandboxed iframes on `about:blank`                   |

Each anchor records a breakage:

- `.spec.ts$` stops the non-spec files under `e2e/` (`helpers.ts`, `mock-saml-idp.ts`, `saml-test-certs.ts`) being collected as tests. A bare `/saml/` matched them and broke `playwright test --list` with "test file should not import test file".
- The `artifact` pattern requires a leading `/` and forbids `/` inside the name, so it matches the _filename_, not a worktree directory containing `artifact-`.
- `min-version-gate` points `baseURL` at the **ungated** frontend on 1421 so `loginViaOidc` drives the run-normally, runtime-flip and header-coverage scenarios. Hard-block navigates to 1423 by absolute URL; exempt-route probes the gated backend on 8004 directly.

### What the Config Spins Up

[`e2e/global-setup.ts`](../../../e2e/global-setup.ts) starts two mock identity providers; the config declares six web servers.

| Component                 | Port   | Notes                                                                                                                                                         |
| ------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Mock OIDC IdP             | `9876` | [`oauth2-mock-server`](https://www.npmjs.com/package/oauth2-mock-server); every issued token is signed for `sub=e2e-test-user` / `email=e2e@thunderbolt.test` |
| Mock SAML IdP             | `9877` | [`e2e/mock-saml-idp.ts`](../../../e2e/mock-saml-idp.ts), with self-signed certs from [`e2e/saml-test-certs.ts`](../../../e2e/saml-test-certs.ts)              |
| OIDC frontend             | `1421` | `bun run dev -- --port 1421`, `VITE_AUTH_MODE=sso`, `VITE_SKIP_ONBOARDING=true`                                                                               |
| OIDC backend              | `8002` | `cd backend && bun run --watch src/index.ts`, `AUTH_MODE=oidc`, rate limiting off, `DATABASE_DRIVER=pglite`                                                   |
| SAML frontend             | `1422` | as above, pointed at the SAML backend                                                                                                                         |
| SAML backend              | `8003` | `AUTH_MODE=saml`, `SAML_ENTRY_POINT` at the mock IdP                                                                                                          |
| Min-version-gate frontend | `1423` | pointed at the gated backend, so its `/config` fetch returns a `minAppVersion`                                                                                |
| Min-version-gate backend  | `8004` | `MIN_APP_VERSION=99.0.0`, pinned above the build-fixed `VITE_APP_VERSION`                                                                                     |

- **The 800x band is deliberate.** 8002 is off :8000 so e2e doesn't collide with `make dev`. Locally a warm e2e backend is reused across runs (`reuseExistingServer: !isCI`), safe only because :8000 can never be the one reused.
- **The gate needs its own backend.** Backend env is per-`webServer` and fixed for its life, so an out-of-date client cannot be simulated by flipping a variable mid-run.
- **No shared state.** Every test gets a fresh context and `use.storageState` is `undefined`, so each spec drives the SSO flow itself and no IndexedDB / OPFS data survives. Both mock IdPs stop in [`e2e/global-teardown.ts`](../../../e2e/global-teardown.ts).
- **`workers: 1` is intentional.** A CI runner already hosts several Vite and backend servers on 4 vCPUs; a second browser worker oversubscribes it and starves the cold first-navigation transpile. The 60s per-test timeout and 10s `expect` floor share that cause.
- **Parallelism comes from sharding.** [`e2e.yml`](../../../.github/workflows/e2e.yml) runs `--shard=1/2` and `--shard=2/2` as separate jobs with the `blob` reporter, then merges them into an HTML report published as the `e2e-report` artifact.

### Helpers

`e2e/helpers.ts` keeps specs short:

- **`loginViaOidc(page)`**: navigates to `/` and waits for the chat textarea while `AuthGate → /sso-redirect → mock IdP → backend callback → session` runs. The mock IdP auto-approves, so there is nothing to type.
- **`loginViaSaml(page)`**: same shape against the SAML mock IdP, which auto-generates the `SAMLResponse` and posts it to the ACS endpoint.
- **`logoutViaSidebar(page, option)`**: opens the account popover, clicks "Log out", optionally picks "Delete data from device" (`option: 'delete'`), confirms, waits for the signed-out page.
- **`loginViaEmailCode(page)`**: requests a sign-in code for a unique `@thunderbolt.test` address, enters the fixed code `12345678`, waits for the chat textarea, and returns the address. A fresh address per call avoids the per-email OTP cooldown, and `WAITLIST_AUTO_APPROVE_DOMAINS=thunderbolt.test` is required because a pending waitlist user's sign-in codes are deleted.
- **`collectPageErrors(page)`**: subscribes to `pageerror` and returns an errors array, filtering harmless Tauri-only noise (`__TAURI__`, `convertFileSrc`).

### Current Specs

`oidc` project:

| Spec                                                                                    | What it verifies                                                                                                                                      |
| --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`oidc-login.spec.ts`](../../../e2e/oidc-login.spec.ts)                                 | Anonymous user completes the full OIDC redirect loop and lands in the chat UI, with no critical JS errors                                             |
| [`oidc-logout.spec.ts`](../../../e2e/oidc-logout.spec.ts)                               | Sign-out lands on the signed-out page, can sign back in, and does not auto-reauthenticate                                                             |
| [`oidc-session.spec.ts`](../../../e2e/oidc-session.spec.ts)                             | Chat UI and sidebar navigation stay functional and signed in after login                                                                              |
| [`oidc-language-picker.spec.ts`](../../../e2e/oidc-language-picker.spec.ts)             | Picking a language flips `X-App-Language` without a reload, survives a reload, resets to the negotiated language, and clears on a data-wipe sign-out  |
| [`oidc-localization.spec.ts`](../../../e2e/oidc-localization.spec.ts)                   | Unit defaults seed from the browser region (never falling back to US), the date-format row is retired, and unit labels re-render on a language switch |
| [`acp-built-in.spec.ts`](../../../e2e/acp-built-in.spec.ts)                             | The built-in ACP adapter exposes the prompt input without errors                                                                                      |
| [`acp-add-custom-agent.spec.ts`](../../../e2e/acp-add-custom-agent.spec.ts)             | Submitting the add-agent form persists a new row to the list                                                                                          |
| [`acp-system-agent-discovery.spec.ts`](../../../e2e/acp-system-agent-discovery.spec.ts) | A discovered system agent appears in the System section and is not removable                                                                          |
| [`proxy-fetch.spec.ts`](../../../e2e/proxy-fetch.spec.ts)                               | A GET through `/v1/proxy` carries `X-Proxy-Target-Url` and unwraps passthrough response headers                                                       |
| [`proxy-passthrough-headers.spec.ts`](../../../e2e/proxy-passthrough-headers.spec.ts)   | Caller headers are wrapped as passthrough headers and the body is forwarded verbatim                                                                  |
| [`proxy-websocket.spec.ts`](../../../e2e/proxy-websocket.spec.ts)                       | `createProxyWebSocket` carries the target URL as `tbproxy.target.<base64url>` on `/proxy/ws`                                                          |
| [`proxy-mcp.spec.ts`](../../../e2e/proxy-mcp.spec.ts)                                   | MCP traffic routes through `/v1/proxy` with target URL and passthrough headers intact                                                                 |

`saml` project:

| Spec                                                        | What it verifies                                                              |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------- |
| [`saml-login.spec.ts`](../../../e2e/saml-login.spec.ts)     | Anonymous user completes the full SAML redirect loop and lands in the chat UI |
| [`saml-logout.spec.ts`](../../../e2e/saml-logout.spec.ts)   | Sign-out lands on the signed-out page and does not auto-reauthenticate        |
| [`saml-session.spec.ts`](../../../e2e/saml-session.spec.ts) | SAML session survives navigation and the authenticated user stays signed in   |

`min-version-gate` and `artifact` projects:

| Spec                                                                | What it verifies                                                                                                                                                                                                                                                                                               |
| ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`min-version-gate.spec.ts`](../../../e2e/min-version-gate.spec.ts) | A below-min build is hard-blocked and never opens a sync stream; an at-or-above build runs ungated; the backend gate spans every route but exempts config, health, preflight and SSO callbacks; a runtime 426 raises the blocker mid-session; `X-App-Version` reaches our backend and never a proxied upstream |
| [`artifact-harness.spec.ts`](../../../e2e/artifact-harness.spec.ts) | The wrapped artifact HTML reports ready plus a content height, surfaces uncaught exceptions and unhandled rejections as errors, and survives a blocked subresource                                                                                                                                             |

### Writing New Specs

- Name the file to match its project: `oidc-*`, `acp-*`, `proxy-*`, `saml-*`, `min-version-gate`, `artifact-*`. A file matching no pattern is silently never run.
- Start any test needing an authenticated user with `loginViaOidc(page)`, `loginViaSaml(page)` or `loginViaEmailCode(page)`.
- Run `bun run e2e:check-collected` after adding a spec. [`scripts/check-e2e-specs-collected.ts`](../../../scripts/check-e2e-specs-collected.ts) checks the union of [`playwright.config.ts`](../../../playwright.config.ts) and [`playwright.preview.config.ts`](../../../playwright.preview.config.ts), and CI fails on an uncollected spec, which is what stops a silently-never-run file from shipping.
- Call `collectPageErrors(page)` and assert the array is empty at the end; some regressions surface only as uncaught exceptions.
- Keep each spec to one user-visible flow. The suite is a smoke test, not a regression matrix: unit-test branching logic, use e2e for "does the whole thing boot".

### Preview Smoke

A separate suite runs against a deployed preview rather than local servers. [`playwright.preview.config.ts`](../../../playwright.preview.config.ts) drives [`e2e/preview-smoke.spec.ts`](../../../e2e/preview-smoke.spec.ts) at the `app-pr-N` and `api-pr-N` services: it waits for API health, signs in as the Keycloak demo user, and checks that chat opens.

The `smoke` job in [`.github/workflows/preview-deploy.yml`](../../../.github/workflows/preview-deploy.yml) runs it after a successful preview deploy and reports a check on the PR. It is deliberately not a required check, so preview infrastructure trouble does not block a merge.

```sh
PREVIEW_APP_URL=https://app-pr-N.preview.thunderbolt.io \
PREVIEW_API_URL=https://api-pr-N.preview.thunderbolt.io \
bun run e2e:preview
```

### Debugging Mock Leakage

These errors in CI while tests pass locally mean a new test file mocked a shared module incompletely:

- `Export named 'X' not found in module`
- `TypeError: X is not a function`
- `undefined is not an object`
