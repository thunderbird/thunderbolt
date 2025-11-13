# Testing

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
- Write unit tests for complex logic, such as branching or algorithms, not for user interactions (e.g., clicking, typing). Testing user interactions via unit tests introduces unnecessary complexity; we plan to use automated QA tools for those scenarios.
- Keep display logic separate from side effects and state in React components by extracting hooks. If a component has many useStates, bundle them into one state hook—this makes logic easy to test and leaves snapshot tests for checking output changes.