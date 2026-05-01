# Testing

## Running Tests

```sh
# Run frontend tests (src/ and scripts/)
bun run test

# Run frontend tests in watch mode
bun run test:watch

# Run backend tests
bun run test:backend

# Run backend tests in watch mode
bun run test:backend:watch

# Run end-to-end tests (Playwright)
bun run e2e
bun run e2e:headed   # with a visible browser
```

**Note**: Don't use `bun test` directly from the project root, as it will pick up both frontend and backend tests. The `test` script is configured to only run tests in `./src` and `./scripts` directories.

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

The Playwright suite in [`e2e/`](../e2e) covers the OIDC sign-in and session flows — the parts of the app that are hardest to exercise from a unit test (browser storage, redirects, Better Auth callbacks).

### What the Config Spins Up

[`playwright.config.ts`](../playwright.config.ts) boots three things before any spec runs:

| Component        | Port   | How                                                              |
| ---------------- | ------ | ---------------------------------------------------------------- |
| Mock OIDC server | `9876` | [`oauth2-mock-server`](https://www.npmjs.com/package/oauth2-mock-server), started by `e2e/global-setup.ts`; every issued token is signed for `sub=e2e-test-user` / `email=e2e@thunderbolt.test` |
| Vite frontend    | `1421` | `bun run dev -- --port 1421` with `VITE_AUTH_MODE=sso` and `VITE_SKIP_ONBOARDING=true` |
| Backend API      | `8000` | `cd backend && bun run dev` with `OIDC_ISSUER` pointed at the mock server, rate limiting disabled |

Each test starts with a fresh `storageState` so stale IndexedDB / OPFS data from a previous run can't leak between specs. A clean shutdown of the mock OIDC server happens in `e2e/global-teardown.ts`.

### Helpers

`e2e/helpers.ts` keeps specs short:

- **`loginViaOidc(page)`** — navigates to `/`, follows `AuthGate → /sso-redirect → mock IdP → backend callback → session`, and waits for the chat textarea to render. The mock IdP auto-approves, so there's no username/password to type. E2E tests use OIDC mode with the mock server; SAML E2E testing requires a real IdP (e.g. Keycloak).
- **`collectPageErrors(page)`** — subscribes to `pageerror` and returns an errors array, filtering Tauri-only noise (`__TAURI__`, `convertFileSrc`, etc.) that the web build surfaces harmlessly.

### Current Specs

| Spec                           | What it verifies                                                                   |
| ------------------------------ | ---------------------------------------------------------------------------------- |
| [`oidc-login.spec.ts`](../e2e/oidc-login.spec.ts)     | Anonymous user completes the full OIDC redirect loop and lands in the chat UI      |
| [`oidc-session.spec.ts`](../e2e/oidc-session.spec.ts) | Session survives a hard reload and the authenticated user stays signed in          |

### Writing New Specs

- Use `loginViaOidc(page)` as the first line of any test that needs an authenticated user.
- Call `collectPageErrors(page)` and assert the array is empty at the end of the test to catch regressions that only surface as uncaught exceptions.
- Keep each spec scoped to a single user-visible flow. The suite is a smoke test, not a full regression matrix — favour unit tests for branching logic and rely on e2e for "does the whole thing boot".

### Debugging Mock Leakage

If you see errors like these in CI but tests pass locally:

- `Export named 'X' not found in module`
- `TypeError: X is not a function`
- `undefined is not an object`

**Check for `mock.module()` calls in recently added test files.** The culprit is usually a test file that mocks a shared module incompletely.
