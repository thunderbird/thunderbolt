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