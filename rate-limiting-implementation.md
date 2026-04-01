# Rate Limiting Implementation

## Overview

IP-based rate limiting for the Thunderbolt backend with three tiers: strict limits on inference (paid LLM APIs), moderate limits on auth (brute force prevention), and standard limits on everything else. All tiers use Postgres-backed storage with isolated counters per tier.

## Why rate limiting?

Several backend endpoints were previously unprotected:

- `/v1/chat/completions` (inference) — proxies to paid LLM APIs (Anthropic, Mistral, etc.). Anyone with the backend URL could burn API credits.
- `/v1/pro/search`, `/v1/pro/fetch-content` — Exa search API, also paid.
- `/v1/pro/proxy/*` — open proxy that could be abused to route traffic through our servers.
- `/v1/api/auth/sign-in/*`, `/v1/api/auth/sign-up/*` — login/signup endpoints that are brute-forceable without rate limits.

Rate limiting adds a safety net that works regardless of whether the user is authenticated.

## Package choice: `elysia-rate-limit`

We evaluated the available options:

| Package | Stars | Maintained | Notes |
|---------|-------|------------|-------|
| `elysia-rate-limit` (rayriffy) | 209 | Yes (v4.5.1, March 2026) | De facto standard, listed on official Elysia plugins page |
| `@nowarajs/elysia-ratelimit` | 1 | Partially | Redis only, too immature |
| `elysia-plugins` (Borderliner) | Low | No | Bundles unrelated features |

No official `@elysiajs/rate-limit` exists.

We went with `elysia-rate-limit` because:

1. It's the only mature, actively maintained option for Elysia.
2. It provides a clean `Context` interface for custom storage backends (5 methods to implement).
3. It handles `RateLimit-*` response headers, the `429` status code, and the `Retry-After` header automatically.
4. It supports `scoping: 'scoped'` for per-route-group limits, which we use for tiered rate limiting.

We did **not** build our own because the package handles all the HTTP-level concerns (headers, skip logic, key generation, scoping) that would be tedious to reimplement and maintain.

## Storage: Postgres (custom adapter)

`elysia-rate-limit` ships with an in-memory LRU cache, which doesn't work for clustered deployments (each worker gets its own counter). No Postgres adapter existed, so we wrote a custom `Context` implementation backed by our existing Postgres database.

### The UPSERT query

The core of the implementation is a single atomic SQL query that handles both insert and increment:

```sql
INSERT INTO rate_limits (ip, count, window_start)
VALUES ($1, 1, NOW())
ON CONFLICT (ip)
DO UPDATE SET
  count = CASE
    WHEN rate_limits.window_start + make_interval(secs => $2) < NOW()
    THEN 1
    ELSE rate_limits.count + 1
  END,
  window_start = CASE
    WHEN rate_limits.window_start + make_interval(secs => $2) < NOW()
    THEN NOW()
    ELSE rate_limits.window_start
  END
RETURNING count, window_start;
```

This gives us:
- **Atomic increment** — no race conditions between concurrent requests
- **Auto-reset** — the window resets automatically when the duration expires
- **Single round-trip** — one DB query per request
- **No cleanup job needed** — stale entries auto-reset on next request

### Tier-prefixed keys

Rate limit counters are isolated per tier by prefixing the IP key: `standard:192.168.1.1`, `auth:192.168.1.1`, `inference:192.168.1.1`. This prevents a user's standard API usage from eating into their inference or auth quota.

### Database table

```sql
CREATE TABLE "rate_limits" (
  "ip" text PRIMARY KEY NOT NULL,
  "count" integer DEFAULT 1 NOT NULL,
  "window_start" timestamp with time zone DEFAULT now() NOT NULL
);
```

The `ip` column stores the tier-prefixed key (e.g., `inference:203.0.113.42`) and is the primary key, which gives us an automatic unique index.

## Configuration

Environment variables (all optional, with sensible defaults):

| Variable | Default | Description |
|----------|---------|-------------|
| `RATE_LIMIT_ENABLED` | `true` | Kill switch for rate limiting |
| `RATE_LIMIT_INFERENCE_MAX` | `20` | Max requests/min for inference |
| `RATE_LIMIT_AUTH_MAX` | `10` | Max requests/15min for auth |
| `RATE_LIMIT_STANDARD_MAX` | `100` | Max requests/min for everything else |

## Tiered limits

All three tiers are active and wired into the Elysia middleware chain:

| Tier | Routes | Limit | Window | Scoping |
|------|--------|-------|--------|---------|
| **Inference** | `/v1/chat/completions` | 20 req | 1 min | Scoped to inference route group |
| **Auth** | `/v1/api/auth/sign-in/*`, `sign-up/*`, `forget-password/*`, `reset-password/*` | 10 req | 15 min | Scoped to BetterAuth plugin |
| **Standard** | All other routes | 100 req | 1 min | Global |

### Exempt paths (not rate limited)

| Path | Why exempt |
|------|-----------|
| `/v1/health` | Health checks (monitoring, load balancers) |
| `/v1/api/auth/get-session` | Frontend polls this on every navigation |
| `/v1/posthog/config` | Analytics config fetched on page load |
| `/v1/posthog/events` | Analytics events sent frequently |

### Auth tier scoping

The auth rate limit only applies to credential-based paths (sign-in, sign-up, password reset). Other auth paths like OIDC callbacks and session checks are exempt to avoid breaking SSO flows and normal app operation.

## IP extraction

Client IP is extracted from standard proxy headers in order of preference:

1. `Forwarded` header (RFC 7239)
2. `X-Forwarded-For` (**rightmost** entry — the one appended by infrastructure, not the leftmost which can be spoofed by clients)
3. `CF-Connecting-IP` (Cloudflare)
4. `True-Client-IP`
5. `X-Real-IP`
6. Bun's `server.requestIP()` (fallback for direct connections)

This logic lives in `extractClientIp()` in `utils/request.ts` and is shared with the HTTP logging middleware.

### Why rightmost X-Forwarded-For?

`X-Forwarded-For` is a comma-separated list where each proxy appends its client's IP. The leftmost entry is what the original client sent — which an attacker can set to anything. The rightmost entry is what our trusted infrastructure (load balancer, CDN) appended, so it's the most reliable.

## What happens when rate limited

- HTTP status: `429 Too Many Requests`
- Response body: `{ "error": "Too many requests. Please try again later." }`
- `RateLimit-*` and `Retry-After` headers are set automatically by the package
- The frontend's existing error handling displays "Something went wrong. Please try again." with a retry button

## Middleware chain order

```
CORS
  → Logger
  → HTTP Logging
  → Error Handling
  → Standard Rate Limit (global, 100 req/min)
  → Auth Rate Limit (scoped to BetterAuth, 10 req/15min on credential paths)
  → Waitlist Auth
  → Route groups (main, google auth, microsoft auth, pro tools, posthog, waitlist, powersync, account)
  → Inference Rate Limit (scoped, 20 req/min) + Inference Routes
```

## Files changed

| File | Change |
|------|--------|
| `backend/src/middleware/rate-limit.ts` | New — Postgres context class + tiered middleware factories |
| `backend/src/middleware/rate-limit.test.ts` | New — 12 unit tests (context + integration) |
| `backend/src/db/rate-limit-schema.ts` | New — Drizzle schema for `rate_limits` table |
| `backend/drizzle/0008_hesitant_texas_twister.sql` | New — migration |
| `backend/src/db/schema.ts` | Re-export rate limit schema |
| `backend/src/config/settings.ts` | Rate limit env vars |
| `backend/src/index.ts` | Wire up all three rate limit tiers |
| `backend/src/utils/request.ts` | Shared `extractClientIp()` utility (rightmost XFF) |
| `backend/src/middleware/http-logging.ts` | Replaced local IP extraction with shared utility |
| `backend/package.json` | Added `elysia-rate-limit` dependency |

## Deployment notes

1. The `rate_limits` table migration must run before the middleware can work. For Postgres deployments, run the migration manually (`bun db migrate`). For PGLite (local dev), migrations run automatically on startup.
2. Rate limiting can be disabled entirely by setting `RATE_LIMIT_ENABLED=false`.
3. The rate limit table will grow by one row per unique `tier:IP` combination. Rows auto-reset on next request after the window expires, so no cleanup job is needed. For very high-traffic deployments, a periodic `DELETE FROM rate_limits WHERE window_start < NOW() - INTERVAL '1 day'` could be added.
