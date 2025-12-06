# Testing

## Running Tests

```sh
# Run frontend tests (src/ and scripts/)
bun test

# Run frontend tests in watch mode
bun test:watch

# Run backend tests
bun test:backend

# Run backend tests in watch mode
bun test:backend:watch
```

**Note**: Don't use `bun test` without arguments from the project root, as it will pick up both frontend and backend tests. The `test` script is configured to only run tests in `./src` and `./scripts` directories.

## Testing Guidelines

Please follow these guidelines for unit tests:

- **Prefer dependency injection over mocking to prevent test pollution.** For example, inject a custom httpClient or fetch for network requests instead of mocking them.
  - ✅ Good: `export const checkInbox = async (params, httpClient: KyInstance = ky) => { ... httpClient.get(...) }`
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

## ⚠️ CRITICAL: Avoid `mock.module()` for Shared Modules

**Bun's `mock.module()` creates global, persistent mocks that leak across test files.** This is the #1 cause of mysterious test failures in CI where tests pass individually but fail when run together.

### The Problem

When you use `mock.module()` to mock a shared module like `@/hooks/use-settings` or `@/components/ui/dialog`, that mock persists for ALL test files running in the same worker:

```ts
// ❌ BAD: This mock will leak to other test files!
mock.module('@/hooks/use-settings', () => ({
  useSettings: () => ({ cloudUrl: { value: 'http://test' } })
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

### Debugging Mock Leakage

If you see errors like these in CI but tests pass locally:
- `Export named 'X' not found in module`
- `TypeError: X is not a function`
- `undefined is not an object`

**Check for `mock.module()` calls in recently added test files.** The culprit is usually a test file that mocks a shared module incompletely.