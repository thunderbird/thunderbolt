# Backend Testing Guide

This guide explains how to write unit/integration tests for the backend using `bun:test`, `Elysia`, and `PGlite` (in-memory PostgreSQL).

## Overview

We use an integration testing pattern where each test runs against a PGlite in-memory database instance. We rely on **Dependency Injection** to pass the test database instance to the application, avoiding the need for module mocking.

For performance and isolation:
- We reuse a single PGlite instance across all tests (keeps WASM loaded)
- We run migrations once during test preload (before any tests run)
- Each test runs inside a transaction that gets rolled back in `afterEach`
- Global `fetch` is mocked to prevent accidental network calls

**Performance:** All tests are fast (~10-30ms) because PGlite initialization happens during the preload phase, completely outside of test execution.

## Key Components

### 1. Test Setup (`src/test-utils/test-setup.ts`)

This file is preloaded via `bunfig.toml` before any tests run. It:
- Initializes PGlite and runs migrations (the slow part)
- Mocks `globalThis.fetch` to throw an error if tests accidentally call it without DI

### 2. Test Utilities (`src/test-utils/db.ts`)

The `createTestDb()` helper function:
- Returns the already-initialized PGlite instance
- Starts a transaction for test isolation
- Returns `client`, `db`, and a `cleanup()` function to rollback

### 3. Dependency Injection

The main application factory `createApp` accepts dependencies as arguments using the `AppDeps` type:

```typescript
// src/types.ts
export type AppDeps = {
  fetchFn?: typeof fetch
  database?: typeof db
}

// src/index.ts
const createApp = async ({ fetchFn = globalThis.fetch, database = db }: AppDeps = {}) => {
  // ...
  // Pass dependencies to routes that need them
  .use(createWaitlistRoutes(database))
}
```

Route creators accept dependencies as arguments:

```typescript
export const createWaitlistRoutes = (database: typeof db) => {
  return new Elysia({ prefix: '/waitlist' })
    .post('/join', async ({ body }) => {
      // Use the injected database instance
      await database.insert(waitlist).values({ email: body.email })
      return { success: true }
    })
}
```

### 4. Writing a Test

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { createTestDb } from '@/test-utils/db'
import { createApp } from '@/index'

describe('My API', () => {
  let app: Awaited<ReturnType<typeof createApp>>
  let db: Awaited<ReturnType<typeof createTestDb>>['db']
  let cleanup: () => Promise<void>

  beforeEach(async () => {
    const testEnv = await createTestDb()
    db = testEnv.db
    cleanup = testEnv.cleanup
    
    // Inject test database
    app = await createApp({ database: db })
  })

  afterEach(async () => {
    // Rollback the transaction to ensure test isolation
    await cleanup()
  })

  it('works', async () => {
    const res = await app.handle(new Request('http://localhost/v1/my-endpoint'))
    expect(res.status).toBe(200)
  })
})
```

**Important:** Always call `cleanup()` in `afterEach` to rollback the transaction and maintain test isolation.

## Mocking External Services

For routes that make external API calls, inject a mock `fetchFn`:

```typescript
const mockFetch = async (input: RequestInfo | URL) => {
  return new Response(JSON.stringify({ data: 'mocked' }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

app = await createApp({ fetchFn: mockFetch, database: db })
```

If a test accidentally calls `fetch` without dependency injection, it will throw a clear error message.

## Running Tests

Run backend tests with:

```bash
cd backend
bun test
```

All tests are fast (~10-30ms) because initialization happens during preload. You can set strict timeouts to catch slow tests.
