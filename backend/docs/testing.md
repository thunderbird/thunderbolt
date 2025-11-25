# Backend Testing Guide

This guide explains how to write unit/integration tests for the backend using `bun:test`, `Elysia`, and `PGlite` (in-memory PostgreSQL).

## Overview

We use an integration testing pattern where each test runs against a PGlite in-memory database instance. We rely on **Dependency Injection** to pass the test database instance to the application, avoiding the need for module mocking.

For performance and isolation:
- We reuse a single PGlite instance across all tests (keeps WASM loaded)
- We run migrations once when the module loads
- Each test runs inside a transaction that gets rolled back in `afterEach`

**Performance Note:** The first test that imports `createTestDb()` will be slower (~700-900ms) due to PGlite's WASM initialization and migration execution. All subsequent tests are very fast (~12-20ms). This is expected and optimal behavior.

## Key Components

### 1. Test Utilities (`src/test-utils/db.ts`)

We have a helper function `createTestDb()` that:
- Creates/reuses an in-memory `PGlite` instance (lazy initialization on first call).
- Runs migrations once when the module loads.
- Starts a transaction for test isolation.
- Returns the `client`, `db`, and a `cleanup()` function to rollback.

### 2. Dependency Injection

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
  // Pass database to routes that need it
  .use(createUsersRoutes({ database }))
}
```

Route creators should also accept the database instance:

```typescript
export const createUsersRoutes = ({ database }: { database: typeof db }) => {
  return new Elysia({ prefix: '/users' })
    .get('/', async () => {
      return await database.select().from(usersTable)
    })
}
```

### 3. Writing a Test (`src/api/users.test.ts` example)

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { createTestDb } from '@/test-utils/db'
import { createApp } from '@/index'
import type { db as DbType } from '@/db/client'

describe('My API', () => {
  let app: Awaited<ReturnType<typeof createApp>>
  let db: typeof DbType
  let cleanup: () => Promise<void>

  beforeEach(async () => {
    const testEnv = await createTestDb()
    db = testEnv.db
    cleanup = testEnv.cleanup
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

## Running Tests

Run backend tests with:

```bash
cd backend
bun test
```

The first database test will take ~700-900ms (PGlite initialization), then all subsequent tests are fast (~12-20ms each).
