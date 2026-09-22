# Backend Testing Guide

This guide explains how to write unit/integration tests for the backend using `bun:test`, `Elysia`, and `PGlite` (in-memory PostgreSQL).

## Overview

We use an integration testing pattern where each test runs against a PGlite in-memory database instance. We rely on **Dependency Injection** to pass the test database instance to the application, avoiding the need for module mocking — `mock.module` leaks across test files in Bun, so every external seam the backend touches (DNS, Exa, the upstream WebSocket constructor, the waitlist email service) is instead an injectable dependency.

For performance and isolation:

- We reuse a single PGlite instance across all tests (keeps WASM loaded)
- We run migrations once during test preload (before any tests run)
- Each test runs inside a transaction that gets rolled back in `afterEach`
- Global `fetch` is mocked to prevent accidental network calls

**Performance:** the PGlite-backed unit and integration suites are fast (tens of milliseconds per test) because PGlite initialization happens during the preload phase, completely outside of test execution. The two segregated WebSocket suites are the exception — see [Running Tests](#running-tests).

## Key Components

### 1. Test Setup (`src/test-utils/test-setup.ts`)

This file is preloaded via `bunfig.toml` before any tests run. It:

- Pins three environment variables before anything imports `@/config/settings` or `@/db/client`:
  - `DATABASE_DRIVER=pglite`, so `db/client.ts` doesn't throw at module load when `DATABASE_URL` is unset (any test that transitively imports `createApp` hits this)
  - `RATE_LIMIT_ENABLED=false`, because `RateLimiterDrizzle` issues its own queries that bypass PGlite transaction isolation and break rollback cleanup. Every limiter factory returns a bare `new Elysia()` when disabled (`src/middleware/rate-limit.ts`), so no app built through `createApp` throttles; the limiters themselves are tested directly in `src/middleware/rate-limit.test.ts`, which passes `{ enabled: true }` explicitly and runs against `getSharedIsolatedTestDb()`.
  - `BETTER_AUTH_SECRET` to a fixed value, so `signTestToken()` produces signatures the real auth stack accepts
- Initializes PGlite and runs migrations (the slow part)
- Mocks `globalThis.fetch` to throw an error if tests accidentally call it without DI (the original is stashed on `globalThis.__originalFetch` for tests that opt in)
- Registers a global `afterAll` that closes the shared PGlite instance, the shared isolated instance, and the lazily-loaded `db/client` singleton. PGlite 0.4.x leaves WASM worker threads open without an explicit `close()`, which crashes Bun with exit code 99 under `--rerun-each`.

### 2. Choosing a database harness (`src/test-utils/db.ts`)

Three harnesses, in order of preference:

| Helper                      | What you get                                                | Use when                                                                                                   |
| --------------------------- | ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `createTestDb()`            | The shared PGlite instance inside a `BEGIN`/`ROLLBACK`      | Default. Anything driven through `app.handle(...)`.                                                        |
| `getSharedIsolatedTestDb()` | One shared isolated PGlite (own connection, committed rows) | Suites that cannot use the singleton: real `.listen()` servers, middleware that opens nested transactions. |
| `createIsolatedTestDb()`    | A brand-new PGlite with its own WASM runtime                | Only when a suite genuinely needs its own instance.                                                        |

`createTestDb()` returns `client`, `db`, and a `cleanup()` that rolls the transaction back.

`getSharedIsolatedTestDb()` returns an `IsolatedTestDb` (`client`, `db`, `close()`). It exists because the shared singleton sits mid-`BEGIN`/`ROLLBACK` and serializes every test file through one WASM mutex: code that opens its own nested transaction (`RateLimiterDrizzle`) loses isolation there, and a read issued by a real `.listen()` server can be head-of-line-blocked behind another test's open transaction. A `new PGlite()` per `describe` — multiplied by the `--rerun-each` passes — accumulated WASM workers on CI until `new PGlite()` hung, hence one shared instance rather than one per suite. Since it is shared and its rows commit, **callers must use unique rows or clear the tables they own between tests**. It is closed once in the global `afterAll`; do not close it yourself.

`createIsolatedTestDb()` hands lifecycle to you: `await close()` in `afterAll`, or Bun exits 99 under `--rerun-each`.

### 3. Dependency Injection

The main application factory takes a single optional `AppDeps` bag ([`src/types.ts`](../src/types.ts)) and resolves defaults internally:

```typescript
// src/index.ts
export const createApp = async (deps?: AppDeps) => {
  const fetchFn = deps?.fetchFn ?? globalThis.fetch
  // The database is imported lazily so tests/CI without DATABASE_URL can inject one instead
  let database = deps?.database
  if (!database) {
    const { db } = await import('@/db/client')
    database = db
  }
  // ...
}
```

Every field is optional. What each one is for:

| Field                  | Injected instead of                                                         |
| ---------------------- | --------------------------------------------------------------------------- |
| `database`             | the real `db/client` singleton                                              |
| `fetchFn`              | `globalThis.fetch` (which the preload booby-traps)                          |
| `auth`                 | the real Better Auth instance — see `src/test-utils/mock-auth.ts`           |
| `waitlistEmailService` | Resend sends from the waitlist routes                                       |
| `otpCooldownMs`        | the 15s per-email OTP cooldown; pass `0` to disable                         |
| `upstreamWsFactory`    | `globalThis.WebSocket` for the proxy's WS relay, keeping traffic in-process |
| `proxyObservability`   | the Pino-backed recorder (proxy events deliberately skip PostHog)           |
| `dnsLookup`            | `dns.promises.lookup` in the SSRF validator                                 |
| `searchExaClient`      | the Exa client the `/search` route resolves from `EXA_API_KEY`              |

The last two are injectable specifically so tests never reach for `mock.module('node:dns')` or `mock.module('exa-js')`, which leak across files.

Route creators take an options object rather than positional dependencies:

```typescript
// src/waitlist/routes.ts
export const createWaitlistRoutes = ({
  database,
  auth,
  emailService = defaultEmailService,
  cooldownMs = defaultCooldownMs,
  ipRateLimit,
}: WaitlistRoutesOptions) => {
  // ...
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

## Test helpers

Beyond `test-setup.ts` and `db.ts`, `src/test-utils/` holds:

- **`mock-auth.ts`** — auth test doubles. `mockAuth` (always a `test-user` session), `mockAuthUnauthenticated` (always `null`), `createMockAuth(id, isAnonymous?)`, and `createThrowingAuth(error)` for the error path. Pass any of them as `createApp({ auth })`.
- **`auth-token.ts`** — `signTestToken(token)` HMACs a bearer the way Better Auth does, using `betterAuthTestSecret` (the same value the preload pins into `BETTER_AUTH_SECRET`).
- **`otp-challenge.ts`** — `createTestChallenge(db, email)` inserts the challenge row that `auth.api.signInEmailOTP` requires.
- **`cli-device.ts`** — `registerCliDevice(app, signedToken, deviceId, options)` issues the `PUT /v1/account/devices/cli` registration request, with `appVersion` overridable (pass `null` to omit `X-App-Version` and exercise the version gate).
- **`settings.ts`** — `createTestSettings(overrides)` builds a fully-populated `Settings` object for code that takes settings directly rather than through `getSettings()`.
- **`posthog.ts`** — `isPosthogRequest(url)` lets a mock fetch handler filter analytics traffic out of its captured calls.
- **`console-spies.ts`** — `setupConsoleSpy()` in `beforeAll`, `restore()` in `afterAll`, for suites that intentionally log.
- **`e2e.ts`** — `createTestApp()` builds an authenticated end-to-end harness: a fresh DB, an approved waitlist user, a real OTP sign-in, and a usable bearer token (`authHeaders(bearerToken)` wraps it). It also exports `e2eDnsLookup` (a deterministic resolver where `private.test` is private and everything else public, so the SSRF paths are testable), plus `createTestUpstream`/`createUpstreamRouter` for routing the proxy's pinned-IP requests to in-process handlers. Pass `database` when the suite binds a real `.listen()` server — then the caller owns that instance's lifecycle and the returned `cleanup` is a no-op.

## Testing settings-dependent code

`getSettings()` memoizes per process ([`src/config/settings.ts`](../src/config/settings.ts)), so mutating `process.env` mid-suite has no effect on its own. Save, set, clear, and restore in both hooks:

```typescript
import { clearSettingsCache } from '@/config/settings'

let savedWaitlistDomains: string | undefined

beforeEach(async () => {
  savedWaitlistDomains = process.env.WAITLIST_AUTO_APPROVE_DOMAINS
  process.env.WAITLIST_AUTO_APPROVE_DOMAINS = 'mozilla.org'
  clearSettingsCache()
  // ...create the app after this point
})

afterEach(async () => {
  if (savedWaitlistDomains !== undefined) {
    process.env.WAITLIST_AUTO_APPROVE_DOMAINS = savedWaitlistDomains
  } else {
    delete process.env.WAITLIST_AUTO_APPROVE_DOMAINS
  }
  clearSettingsCache()
})
```

Restoring matters because tests run `--randomize` and share the process.

## Running Tests

From the repo root:

```bash
# Backend suite, 5s per-test timeout, randomized order
bun run test:backend

# The segregated WebSocket/Haystack suites (very long timeout)
bun run test:backend:ws

# Stability gate — the same suite, five times (unlike CI, this includes the
# two WebSocket suites, and keeps the 5s per-test timeout)
bun run test:backend:5x

# A single file
cd backend && bun test src/waitlist/routes.test.ts --timeout 5000
```

Never run a bare `bun test` from the repo root: it discovers every `*.test.*` file in the repo — frontend, shared, and backend alike — so suites that expect services you have not started hang. Every `test*` script in `package.json` is scoped for that reason (`--cwd=src` for the frontend, `cd backend` for these).

### In CI

[`.github/workflows/ci.yml`](../../.github/workflows/ci.yml) runs the backend job differently from local in four ways worth knowing before you debug a CI-only failure:

- **Bun is pinned to 1.3.13.** 1.3.14 correlated with intermittent hard hangs inside PGlite's WASM, where even the 5s per-test timeout could not fire.
- **There is no meaningful per-test timeout** (`--timeout 3600000`; `--timeout 0` hangs async tests in Bun). A 10-minute step cap is the real ceiling, so a test that is only slow under CI/PGlite contention does not fail spuriously.
- **Everything runs `--rerun-each 5`.** A test that passes once but not five times is a failing test.
- **`src/proxy/ws-e2e.test.ts` and `src/haystack/routes.test.ts` are excluded from that run** and executed once afterwards under a retry wrapper (up to 5 attempts). Both wait on Bun same-process WebSocket close/message events that Bun drops or delays under load. The systematic causes — shared PGlite, missing event waits, over-strict close codes — are fixed; the residual drop is irreducible, so running them once with retries lets an intermittent drop self-heal while five consecutive failures still red CI. Keep new WebSocket e2e tests in those files, or they inherit the 5x exposure.
