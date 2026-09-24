# Backend Testing Guide

Backend tests run on `bun:test`, `Elysia`, and `PGlite` (in-memory PostgreSQL).

## Overview

Tests that touch the database run against PGlite, passed in by **dependency
injection**. `mock.module` leaks across test files in Bun, so every external
seam (DNS, Exa, the upstream WebSocket constructor, the waitlist email service)
is injected instead. A pure unit test needs no database and should not open a
transaction.

- One PGlite instance is reused across all tests (keeps WASM loaded).
- Migrations run once during test preload.
- Tests that call `createTestDb()` run inside a transaction rolled back in `afterEach`.
- Global `fetch` is mocked to prevent accidental network calls.

PGlite initializes in preload, so these suites run in tens of milliseconds per test. The two segregated WebSocket suites are the exception (see [Running Tests](#running-tests)).

## Key Components

### 1. Test Setup (`src/test-utils/test-setup.ts`)

Preloaded via `bunfig.toml` before any tests run. It:

- Pins three environment variables before anything imports `@/config/settings` or `@/db/client`:
  - `DATABASE_DRIVER=pglite`, so `db/client.ts` doesn't throw at module load when `DATABASE_URL` is unset (any test that transitively imports `createApp` hits this).
  - `RATE_LIMIT_ENABLED=false`, because `RateLimiterDrizzle` issues its own queries that bypass PGlite transaction isolation and break rollback cleanup. Every limiter factory returns a bare `new Elysia()` when disabled (`src/middleware/rate-limit.ts`), so nothing built through `createApp` throttles. The limiters are tested directly in `src/middleware/rate-limit.test.ts`, which passes `{ enabled: true }` and uses `getSharedIsolatedTestDb()`.
  - `BETTER_AUTH_SECRET` to a fixed value, so `signTestToken()` produces signatures the real auth stack accepts.
- Initializes PGlite and runs migrations (the slow part).
- Mocks `globalThis.fetch` to throw if tests call it without DI. The original is stashed on `globalThis.__originalFetch` for tests that opt in.
- Registers a global `afterAll` closing the shared PGlite instance, the shared isolated instance, and the lazily-loaded `db/client` singleton. PGlite 0.4.x leaves WASM worker threads open without an explicit `close()`, crashing Bun with exit code 99 under `--rerun-each`.

### 2. Choosing a database harness (`src/test-utils/db.ts`)

| Helper                      | What you get                                                | Use when                                                                                                   | Cleanup                                                             |
| --------------------------- | ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `createTestDb()`            | The shared PGlite instance inside a `BEGIN`/`ROLLBACK`      | Default. Anything driven through `app.handle(...)`.                                                        | `cleanup()` in `afterEach`, or isolation is lost                    |
| `getSharedIsolatedTestDb()` | One shared isolated PGlite (own connection, committed rows) | Suites that cannot use the singleton: real `.listen()` servers, middleware that opens nested transactions. | None; global `afterAll` owns it                                     |
| `createIsolatedTestDb()`    | A brand-new PGlite with its own WASM runtime                | Only when a suite genuinely needs its own instance.                                                        | `await close()` in `afterAll`, or Bun exits 99 under `--rerun-each` |

`createTestDb()` returns `client`, `db`, and a `cleanup()` that rolls the transaction back; the isolated helpers return an `IsolatedTestDb` (`client`, `db`, `close()`).

The shared singleton sits mid-`BEGIN`/`ROLLBACK` and serializes every test file through one WASM mutex: a nested transaction (`RateLimiterDrizzle`) loses isolation, and a real `.listen()` server's read can block behind another test's open transaction. `getSharedIsolatedTestDb()` is shared rather than per-suite because a `new PGlite()` per `describe`, times the `--rerun-each` passes, accumulated WASM workers on CI until `new PGlite()` hung. Its rows commit, so **callers must use unique rows or clear the tables they own between tests**.

### 3. Dependency Injection

`createApp` takes one optional `AppDeps` bag ([`src/types.ts`](../src/types.ts)) and resolves defaults internally. Every field is optional:

| Field                  | Injected instead of                                                                               |
| ---------------------- | ------------------------------------------------------------------------------------------------- |
| `database`             | the real `db/client` singleton, imported lazily so tests/CI without `DATABASE_URL` can inject one |
| `fetchFn`              | `globalThis.fetch` (which the preload booby-traps)                                                |
| `auth`                 | the real Better Auth instance (see `src/test-utils/mock-auth.ts`)                                 |
| `waitlistEmailService` | Resend sends from the waitlist routes                                                             |
| `otpCooldownMs`        | the 15s per-email OTP cooldown; pass `0` to disable                                               |
| `upstreamWsFactory`    | `globalThis.WebSocket` for the proxy's WS relay, keeping traffic in-process                       |
| `proxyObservability`   | the Pino-backed recorder (proxy events deliberately skip PostHog)                                 |
| `dnsLookup`            | `dns.promises.lookup` in the SSRF validator                                                       |
| `searchExaClient`      | the Exa client the `/search` route resolves from `EXA_API_KEY`                                    |

`dnsLookup` and `searchExaClient` are injectable so tests never reach for `mock.module('node:dns')` or `mock.module('exa-js')`, which leak across files.

Route creators take an options object rather than positional dependencies (see `createWaitlistRoutes` in [`src/waitlist/routes.ts`](../src/waitlist/routes.ts)).

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
    app = await createApp({ database: db })
  })

  afterEach(async () => {
    await cleanup()
  })

  it('works', async () => {
    const res = await app.handle(new Request('http://localhost/v1/my-endpoint'))
    expect(res.status).toBe(200)
  })
})
```

**If you call `createTestDb()`, call `cleanup()` in `afterEach`** to roll back
its transaction. Do not call it just to open one.

## Mocking External Services

Inject a mock `fetchFn`; calling `fetch` without DI throws a clear error.

```typescript
const mockFetch = async (input: RequestInfo | URL) => new Response(JSON.stringify({ data: 'mocked' }), { status: 200 })

app = await createApp({ fetchFn: mockFetch, database: db })
```

## Test helpers

Beyond `test-setup.ts` and `db.ts`, `src/test-utils/` holds:

| File               | Exports                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mock-auth.ts`     | `mockAuth` (always a `test-user` session), `mockAuthUnauthenticated` (always `null`), `createMockAuth(id, isAnonymous?)`, `createThrowingAuth(error)`. Pass any as `createApp({ auth })`.                                                                                                                                                                                 |
| `auth-token.ts`    | `signTestToken(token)` HMACs a bearer the way Better Auth does, using `betterAuthTestSecret` (the value the preload pins into `BETTER_AUTH_SECRET`).                                                                                                                                                                                                                      |
| `otp-challenge.ts` | `createTestChallenge(db, email)` inserts the challenge row `auth.api.signInEmailOTP` requires.                                                                                                                                                                                                                                                                            |
| `cli-device.ts`    | `registerCliDevice(app, signedToken, deviceId, options)` issues `PUT /v1/account/devices/cli`. Pass `appVersion: null` to omit `X-App-Version` and exercise the version gate.                                                                                                                                                                                             |
| `settings.ts`      | `createTestSettings(overrides)` builds a full `Settings` object for code taking settings directly rather than through `getSettings()`.                                                                                                                                                                                                                                    |
| `posthog.ts`       | `isPosthogRequest(url)` filters analytics traffic out of a mock fetch handler's captured calls.                                                                                                                                                                                                                                                                           |
| `console-spies.ts` | `setupConsoleSpy()` in `beforeAll`, `restore()` in `afterAll`, for suites that intentionally log.                                                                                                                                                                                                                                                                         |
| `e2e.ts`           | `createTestApp()` (fresh DB, approved waitlist user, real OTP sign-in, bearer token; `authHeaders(bearerToken)` wraps it), `e2eDnsLookup` (deterministic resolver where `private.test` is private and everything else public, so SSRF paths are testable), `createTestUpstream`/`createUpstreamRouter` for routing the proxy's pinned-IP requests to in-process handlers. |

Pass `database` to `createTestApp()` when the suite binds a real `.listen()` server: the caller then owns that instance's lifecycle and the returned `cleanup` is a no-op.

## Testing settings-dependent code

`getSettings()` memoizes per process ([`src/config/settings.ts`](../src/config/settings.ts)), so mutating `process.env` mid-suite has no effect on its own. Save, set, clear, and restore in both hooks. Restoring matters because tests run `--randomize` and share the process.

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

## Running Tests

From the repo root:

```bash
# Backend suite, 5s per-test timeout, randomized order
bun run test:backend

# The segregated WebSocket/Haystack suites (very long timeout)
bun run test:backend:ws

# Stability gate: the same suite five times. Unlike CI, this includes the
# two WebSocket suites and keeps the 5s per-test timeout.
bun run test:backend:5x

# A single file
cd backend && bun test src/waitlist/routes.test.ts --timeout 5000
```

Never run a bare `bun test` from the repo root: it discovers every `*.test.*` file in the repo, so suites expecting services you have not started hang. Every `test*` script in `package.json` is scoped for that reason (`--cwd=src` for the frontend, `cd backend` here).

### In CI

[`.github/workflows/ci.yml`](../../.github/workflows/ci.yml) runs the backend job differently from local in four ways:

- **Bun is pinned to 1.3.13.** 1.3.14 correlated with intermittent hard hangs inside PGlite's WASM, where even the 5s per-test timeout could not fire.
- **No meaningful per-test timeout** (`--timeout 3600000`; `--timeout 0` hangs async tests in Bun). The 10-minute step cap is the real ceiling, so a test only slow under CI/PGlite contention does not fail spuriously.
- **Everything runs `--rerun-each 5`.** A test that passes once but not five times is a failing test.
- **`src/proxy/ws-e2e.test.ts` and `src/haystack/routes.test.ts` are excluded from that run**, then run once afterwards under a retry wrapper (up to 5 attempts). Both wait on same-process WebSocket close/message events that Bun drops or delays under load. The systematic causes (shared PGlite, missing event waits, over-strict close codes) are fixed; the residual drop is irreducible, so one run with retries self-heals while five consecutive failures still red CI. Keep new WebSocket e2e tests in those files, or they inherit the 5x exposure.
