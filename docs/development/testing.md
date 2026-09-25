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

**Note**: Don't run `bun test` directly from the project root — Bun's positional args are substring filters (not paths), so a filter like `src/` matches `backend/src/...` and pulls in backend tests. The `test` script uses `bun test --cwd=src` to scope discovery to the frontend tree, then runs the `shared/` test paths it enumerates (`shared/*.test.ts`, `shared/defaults/`, `shared/i18n/` — `shared/agent-core/` has its own `test:agent-core` script), `scripts/create-release.test.ts`, `scripts/check-e2e-specs-collected.test.ts`, `scripts/notify-on-failure.test.ts`, `scripts/sanitize-nightly-artifacts.test.ts`, and the selected `.github/scripts/*.test.*` files by explicit path (`shared/` is outside `--cwd=src`, and Bun skips hidden dirs in discovery, so each path must be explicit). It runs `bun test --cwd=e2e db-diagnostic.test.ts` separately because root `bunfig.toml` excludes `e2e/**` from Bun discovery; Playwright collects only `*.spec.ts` files.

**`shared/agent-core` is the app's in-browser adapter around the npm `@earendil-works/pi-agent-core` package**, not that package itself. Its nested unit tests sit outside frontend test discovery, so they are intentionally **not** part of `bun run test`. Run them with `bun run test:agent-core` (or `bun run test:agent-core:5x` for the 5x-stability gate). In CI, the dedicated `agent-core` job in [`ci.yml`](../../.github/workflows/ci.yml) runs the 5x unit gate and browser check when the module, dependencies, build configuration, browser check, or workflow changes. The CLI imports the npm Pi package directly and imports the OpenAI-compatible and confidential-model builders plus receipt lifecycle from `shared/agent-core`, unit-tested by `bun run test:agent-core`; its integration coverage remains in the CLI suite.

`test:agent-core:browser` builds into a temporary directory and imports the emitted app chunk in both engines, with native iterator helpers and with those helpers removed before import. It exercises two conversation turns through the OpenRouter, Thunderbolt, and confidential-model harness paths using injected SSE responses, then verifies OPFS data survives reload. Run this check on macOS, as the CI job does: Playwright's Linux WebKit build lacks the storage API needed for OPFS. Each case uses a fresh persistent browser profile because WebKit's ephemeral contexts reject OPFS. This is a dependency/runtime regression check, not authenticated provider or native-device coverage. To check an existing production build, set `BROWSER_TEST_DIST=/absolute/path/to/build`; the script leaves that build untouched and cleans up its own profiles.

## Testing Guidelines

Please follow these guidelines for unit tests:

- **Prefer dependency injection over mocking to prevent test pollution.** For example, inject a custom httpClient or fetch for network requests instead of mocking them.
  - ✅ Good: `export const checkInbox = async (params, httpClient: HttpClient = ky) => { ... httpClient.get(...) }`
  - ❌ Bad: `mock.module('ky', () => ({ ... }))`
- **Fake timers are installed globally for all tests.** This ensures tests run quickly and deterministically.
  - Timers are automatically installed before each test and uninstalled after
  - If you need to manually advance time, use `getClock()` from `@/testing-library`:

    ```ts
    import { getClock } from '@/testing-library'

    await act(async () => {
      await getClock().runAllAsync()
    })
    ```

  - This also speeds up tests that use HTTP libraries with retry logic (like `ky`)

- **Suppress expected console errors in tests** - use `spyOn(console, 'error').mockImplementation(() => {})` in `beforeAll` for tests that intentionally trigger errors
- Always write unit tests for logic, code branching, and algorithms - these should be thoroughly covered. Unit tests for component user interactions (such as clicking or typing) are optional and might be better covered by higher-level tests (e.g., with Cypress).
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

## End-to-End Tests

The Playwright suite in [`e2e/`](../../e2e) covers OIDC and SAML sign-in and session flows, consumer email-code sign-in, chat streaming, and settings persistence — the parts of the app that are hardest to exercise from a unit test (browser storage, redirects, Better Auth callbacks).

### What the Config Spins Up

[`playwright.config.ts`](../../playwright.config.ts) starts these services before any spec runs. Ports below are the defaults; each pair lists frontend / backend ports.

| Component             | Port            | Mode / purpose                                            |
| --------------------- | --------------- | --------------------------------------------------------- |
| Mock OIDC server      | `9876`          | Auto-approves sign-in as `e2e@thunderbolt.test`           |
| Mock SAML IdP         | `9877`          | Issues SAML responses for sign-in                         |
| Fake provider         | `9878`          | Streams a scripted chat reply                             |
| OIDC pair             | `1421` / `8002` | SSO frontend, OIDC backend                                |
| SAML pair             | `1422` / `8003` | SSO frontend, SAML backend                                |
| Min-version gate pair | `1423` / `8004` | SSO frontend, OIDC backend with `MIN_APP_VERSION=99.0.0`  |
| Consumer pair         | `1424` / `8005` | Email-code sign-in, consumer backend with `NODE_ENV=test` |

Regular PR tests start with fresh browser contexts and `storageState`. Nightly WebKit uses persistent profiles for OPFS support and clears OPFS on the test frontend origins before each case, since WebKit can share OPFS between separate profiles. `e2e/global-setup.ts` starts the mock IdPs and fake provider; `e2e/global-teardown.ts` stops them.

### Fake provider

The fake provider in [`e2e/fake-provider.ts`](../../e2e/fake-provider.ts) is a local server that serves the Anthropic Messages streaming protocol on `/v1/messages`, with text deltas, token usage, and a final `message_stop` event. Change its exported `fakeProviderReply` to change the scripted reply. `e2e/consumer-fake-provider.spec.ts` checks the stream directly.

The consumer backend sets `ANTHROPIC_BASE_URL=http://localhost:9878` to its API root to reach it. See the [self-hosting configuration](../self-hosting/configuration.md) for the override. The fake provider sits behind the real backend, so chat tests exercise quota admission, usage logging, and stream re-emission.

### Consumer-mode pair and the fixed sign-in code

The consumer backend runs with `NODE_ENV=test`. Only in that environment does the OTP generator issue the fixed `testSignInOtp` value `12345678`, defined in `backend/src/auth/otp-constants.ts`. Other environments keep the normal random generator.

`WAITLIST_AUTO_APPROVE_DOMAINS=thunderbolt.test` approves the test email domain. This is necessary because pending waitlist users have their sign-in codes deleted. `loginViaEmailCode(page)` generates and returns a unique `@thunderbolt.test` address per call to avoid the per-email OTP cooldown, and enters the fixed code `12345678` to complete the flow.

### Helpers

`e2e/helpers.ts` keeps specs short:

- **`loginViaOidc(page)`** — navigates to `/`, follows `AuthGate → /sso-redirect → mock IdP → backend callback → session`, and waits for the chat textarea to render. The mock IdP auto-approves, so there's no username/password to type.
- **`loginViaSaml(page)`** — follows the SAML redirect through the mock IdP and waits for the chat textarea.
- **`loginViaEmailCode(page)`** — requests a sign-in code for a unique test email, enters the fixed code, waits for the chat textarea, and returns the email.
- **`openSidebarOnMobile(page)`** — opens the mobile drawer before a test selects sidebar content; desktop needs no action.
- **`collectPageErrors(page)`** — subscribes to `pageerror` and returns an errors array, filtering Tauri-only noise (`__TAURI__`, `convertFileSrc`, etc.) that the web build surfaces harmlessly.

### Current Specs

| Spec                                                                                       | What it verifies                                                                                         |
| ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| [`oidc-login.spec.ts`](../../e2e/oidc-login.spec.ts)                                       | Anonymous user completes the full OIDC redirect loop and lands in the chat UI                            |
| [`oidc-logout.spec.ts`](../../e2e/oidc-logout.spec.ts)                                     | OIDC user can sign out and is redirected to the signed-out page                                          |
| [`oidc-session.spec.ts`](../../e2e/oidc-session.spec.ts)                                   | Chat, sidebar navigation, and signed-in state work after OIDC login                                      |
| [`saml-login.spec.ts`](../../e2e/saml-login.spec.ts)                                       | Anonymous user completes the full SAML redirect loop and lands in the chat UI                            |
| [`saml-logout.spec.ts`](../../e2e/saml-logout.spec.ts)                                     | SAML user can sign out and is redirected to the signed-out page                                          |
| [`saml-session.spec.ts`](../../e2e/saml-session.spec.ts)                                   | Chat, sidebar navigation, and signed-in state work after SAML login                                      |
| [`consumer-email-code-login.spec.ts`](../../e2e/consumer-email-code-login.spec.ts)         | Email-code sign-in lands in the chat UI                                                                  |
| [`consumer-chat-streaming.spec.ts`](../../e2e/consumer-chat-streaming.spec.ts)             | Sending a message streams the fake provider reply into chat                                              |
| [`consumer-settings-persistence.spec.ts`](../../e2e/consumer-settings-persistence.spec.ts) | A language change persists after reload                                                                  |
| [`consumer-fake-provider.spec.ts`](../../e2e/consumer-fake-provider.spec.ts)               | The fake provider streams a complete reply and token usage                                               |
| [`oidc-language-picker.spec.ts`](../../e2e/oidc-language-picker.spec.ts)                   | Language selection updates request headers, survives reload, and resets with a data wipe                 |
| [`oidc-localization.spec.ts`](../../e2e/oidc-localization.spec.ts)                         | Regional unit defaults and translated labels follow the selected language                                |
| [`min-version-gate.spec.ts`](../../e2e/min-version-gate.spec.ts)                           | Below-minimum versions are blocked, exempt routes work, and app version headers stay on backend requests |
| [`acp-built-in.spec.ts`](../../e2e/acp-built-in.spec.ts)                                   | The chat prompt renders without errors after login                                                       |
| [`acp-add-custom-agent.spec.ts`](../../e2e/acp-add-custom-agent.spec.ts)                   | Adding a custom agent persists it in the list                                                            |
| [`acp-system-agent-discovery.spec.ts`](../../e2e/acp-system-agent-discovery.spec.ts)       | Discovered system agents appear and cannot be removed                                                    |
| [`proxy-fetch.spec.ts`](../../e2e/proxy-fetch.spec.ts)                                     | Proxied GET requests carry the target URL and expose passthrough response headers                        |
| [`proxy-passthrough-headers.spec.ts`](../../e2e/proxy-passthrough-headers.spec.ts)         | Proxied requests forward caller headers and body                                                         |
| [`proxy-mcp.spec.ts`](../../e2e/proxy-mcp.spec.ts)                                         | MCP traffic uses the proxy with target and passthrough headers                                           |
| [`proxy-websocket.spec.ts`](../../e2e/proxy-websocket.spec.ts)                             | WebSocket proxy connections carry the target URL                                                         |
| [`artifact-harness.spec.ts`](../../e2e/artifact-harness.spec.ts)                           | Sandboxed artifacts report readiness, height, and runtime errors                                         |
| [`preview-smoke.spec.ts`](../../e2e/preview-smoke.spec.ts)                                 | A deployed preview signs in through Keycloak and opens chat                                              |

### Writing New Specs

- Use `loginViaOidc(page)`, `loginViaSaml(page)`, or `loginViaEmailCode(page)` for tests that need an authenticated user.
- Name each spec to match a project's `testMatch`, such as `consumer-*.spec.ts`, `oidc-*.spec.ts`, or `saml-*.spec.ts`. Run `bun run e2e:check-collected` to verify collection. Its script, `scripts/check-e2e-specs-collected.ts`, checks the union of `playwright.config.ts`, `playwright.preview.config.ts`, and `playwright.nightly.config.ts`; CI runs it in `.github/workflows/e2e.yml` and fails if any spec is uncollected.
- Call `collectPageErrors(page)` and assert the array is empty at the end of the test to catch regressions that only surface as uncaught exceptions.
- Keep each spec scoped to a single user-visible flow. The suite is a smoke test, not a full regression matrix — favour unit tests for branching logic and rely on e2e for "does the whole thing boot".

### Preview smoke

Preview smoke uses `playwright.preview.config.ts` and `e2e/preview-smoke.spec.ts` against the deployed `app-pr-N` / `api-pr-N` services. It waits for API health, signs in with the Keycloak demo user, and checks that chat opens. The `smoke` job in `.github/workflows/preview-deploy.yml` runs after a successful preview deploy and reports a check on the PR. It is deliberately not a required check, so preview infrastructure failures do not block merges.

To run it locally, replace `N` with the PR number:

```sh
PREVIEW_APP_URL=https://app-pr-N.preview.thunderbolt.io \
PREVIEW_API_URL=https://api-pr-N.preview.thunderbolt.io \
bun run e2e:preview
```

### Nightly E2E

[`nightly.yml`](../../.github/workflows/nightly.yml) runs the Playwright suite on Linux in desktop and mobile Chromium and Firefox, using PostgreSQL and PowerSync containers. On macOS it runs desktop and iPhone WebKit with in-memory test backends. The regular PR workflow, [`e2e.yml`](../../.github/workflows/e2e.yml), runs Chromium.

On a Mac, install WebKit and run the Nightly config from the repository root:

```sh
bunx playwright install webkit
bunx playwright test --config playwright.nightly.config.ts
```

On Linux, first start and migrate PostgreSQL, then start PowerSync using [`nightly-compose.yml`](../../deploy/nightly-compose.yml) and the setup in [`nightly.yml`](../../.github/workflows/nightly.yml). Set `NIGHTLY_DATABASE_URL` and `NIGHTLY_POWERSYNC_URL` to those services before running the same Playwright command. See [`playwright.nightly.config.ts`](../../playwright.nightly.config.ts) for browser selection and backend environment variables.

### Debugging Mock Leakage

If you see errors like these in CI but tests pass locally:

- `Export named 'X' not found in module`
- `TypeError: X is not a function`
- `undefined is not an object`

**Check for `mock.module()` calls in recently added test files.** The culprit is usually a test file that mocks a shared module incompletely.
