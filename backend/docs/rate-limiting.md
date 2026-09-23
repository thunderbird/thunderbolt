# Rate limiting

Hardcoded per-tier budgets, enforced by a Postgres-backed limiter in [backend/src/middleware/rate-limit.ts](../src/middleware/rate-limit.ts) and wired per route group in [backend/src/index.ts](../src/index.ts).

| Tier                      | Budget       | Keyed on              | Routes                                                                                   |
| ------------------------- | ------------ | --------------------- | ---------------------------------------------------------------------------------------- |
| `inference`               | 60 / minute  | user                  | `/v1/chat/*` (managed inference)                                                         |
| `pro`                     | 100 / minute | user                  | `/v1/pro/*`, `/v1/proxy/*`, `/v1/proxy/ws`, `/v1/tinfoil/*`, `/v1/search`, `/v1/preview` |
| `receipt`                 | 100 / minute | user                  | `/v1/inference-usage/receipts`                                                           |
| `auth`                    | 10 / minute  | client IP             | `/v1/api/auth/*`, `/v1/waitlist/*`                                                       |
| `debug-transcript`        | 10 / hour    | user                  | `POST /v1/debug-transcripts`                                                             |
| `debug-transcript-intake` | 600 / hour   | intake client, and IP | `POST /v1/debug-transcripts/intake`                                                      |

Limits are hardcoded in `tierConfigs` ([rate-limit.ts:33](../src/middleware/rate-limit.ts)), not configurable, so every deployment enforces a known floor and no env var can quietly raise it.

Being Postgres-backed rather than in-process, all replicas share one budget. It runs independent of any edge or CDN because several `/v1` routes spend real money or send real email (managed inference, Exa-backed search, link previews, OTP send, waitlist join) and self-hosted deployments have no edge.

Operator configuration (`RATE_LIMIT_ENABLED`, `TRUSTED_PROXY`) is in [docs/self-hosting/configuration.md](../../docs/self-hosting/configuration.md#rate-limiting-and-proxy-trust).

## How tiers map to buckets

The tier name is the limiter's `keyPrefix` ([rate-limit.ts:48](../src/middleware/rate-limit.ts)); `rate-limiter-flexible` stores rows under `<keyPrefix>:<key>`. Two load-bearing consequences:

- **One tier is one bucket, however many times it is mounted.** `proRateLimit` is built once ([index.ts:90](../src/index.ts)) and passed to six route groups, so a user's 100 per minute covers proxy, tinfoil, search and preview combined. The two `createAuthIpRateLimit` calls (Better Auth at [index.ts:95](../src/index.ts), waitlist at [index.ts:198](../src/index.ts)) build two limiter objects that share one `auth:<ip>` bucket.
- **Different tiers never interfere.** Exhausting `inference` leaves `pro` and `receipt` untouched; `rate-limit.test.ts` pins both pairs.

## The three ways to apply a tier

| Factory                                                                          | Bucket key           | Use for                                                                                         |
| -------------------------------------------------------------------------------- | -------------------- | ----------------------------------------------------------------------------------------------- |
| `createUserTierRateLimit` ([rate-limit.ts:112](../src/middleware/rate-limit.ts)) | `user:<id>`          | Authenticated routes. Reads the context the auth macro resolved, with no second `getSession()`. |
| `createIpTierRateLimit` ([rate-limit.ts:151](../src/middleware/rate-limit.ts))   | `ip:<addr>`          | Routes with no session yet. `createAuthIpRateLimit` is the `auth`-tier shorthand.               |
| `createRateLimitConsumer` ([rate-limit.ts:168](../src/middleware/rate-limit.ts)) | Whatever you compute | Keys that are neither session user nor IP. Returns a plain function, not a plugin.              |

Debug-transcript intake is the consumer case: the caller is another deployment with a client key, so the bucket is `client:<id>`, computable only after the handler resolves the key ([debug-transcripts-intake.ts:66](../src/api/debug-transcripts-intake.ts)). An IP-keyed limiter of the same tier wraps it too, so unknown callers burning 401s still hit a ceiling.

With `settings.rateLimitEnabled` false, the plugin factories return a bare `new Elysia()` and the consumer factory returns `null`; nothing downstream changes shape, because call sites treat both as optional.

## Placement rules that will bite you

### The user-keyed plugin must go inside `guard({ auth: true }, …)`

It reads `ctx.user`, populated by the auth macro's `resolve`. At app level the macro resolves _after_ `onBeforeHandle`, so the no-user branch returns without consuming a point ([rate-limit.ts:104](../src/middleware/rate-limit.ts)) and the route is silently unlimited. Call sites: [pro/routes.ts:17](../src/pro/routes.ts), [api/search.ts:37](../src/api/search.ts), [inference/routes.ts:262](../src/inference/routes.ts).

The skip branch is deliberate (such requests 401 anyway), but mounted is not enforcing. The WebSocket proxy mounts `proRateLimit` at plugin level ([proxy/ws.ts:233](../src/proxy/ws.ts)) yet authorises the bearer subprotocol inside `open()` ([proxy/ws.ts:289](../src/proxy/ws.ts)), so the handshake is not user-limited.

### Better Auth is mounted with `.all('/*')`, not `.mount()`

`mount()` short-circuits the pipeline before `onBeforeHandle`, bypassing the IP limiter. The comment at [auth/elysia-plugin.ts:53](../src/auth/elysia-plugin.ts) records this so nobody "tidies" it back.

### IP resolution fails closed

- `extractClientIp` ([utils/request.ts](../src/utils/request.ts)) trusts a proxy header only when `TRUSTED_PROXY` names the edge (`cloudflare` → `CF-Connecting-IP`, `akamai` → `True-Client-IP`). Without one, any client can forge `X-Forwarded-For` and mint a fresh bucket per request.
- An unresolvable address shares a single `ip:unknown` bucket rather than skipping the limit ([rate-limit.ts:144](../src/middleware/rate-limit.ts)); identifiable clients keep their own.
- `getTrustedIpHeaders` feeds the same `TRUSTED_PROXY` value to Better Auth's `ipAddressHeaders`, so both limiters agree on the client. It returns `undefined`, not `[]`, when no proxy is configured: `[]` makes Better Auth resolve a null IP and disable its own limiter.

## Response contract

| Outcome          | Status    | Headers                                                                                      | Body                                                        |
| ---------------- | --------- | -------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| Passes a limiter | unchanged | `RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset` (seconds until the window rolls) | unchanged                                                   |
| Rejected         | `429`     | the above with `RateLimit-Remaining: 0`, plus `Retry-After`                                  | `{ "error": "Too many requests. Please try again later." }` |

See [rate-limit.ts:56](../src/middleware/rate-limit.ts) and [rate-limit.ts:68](../src/middleware/rate-limit.ts).

**Browsers cannot read those headers cross-origin.** None are in `defaultCorsExposeHeaders` ([config/settings.ts:11](../src/config/settings.ts)); adding them via `CORS_EXPOSE_HEADERS` replaces the default list rather than appending, so carry the existing values across. [AGENTS.md](../../AGENTS.md) explains why the expose list is explicit while the allowed-request-header list is not.

**Not every backend `429` is this limiter.** Managed inference returns `429` with `{ "error": { "code": "INFERENCE_QUOTA_EXCEEDED", "window": … } }` from [inference/usage-responses.ts](../src/inference/usage-responses.ts) when a rolling spend quota is exhausted; that body shape is how the client tells a usage ledger from a request counter.

## Storage

Counters live in `rate_limits` ([db/rate-limit-schema.ts](../src/db/rate-limit-schema.ts), created by `backend/drizzle/0008_known_shockwave.sql`): a `key` primary key, a `points` counter, an indexed `expire` timestamp. `rate-limiter-flexible`'s Drizzle adapter dictates that shape, so do not reshape it. The limiter sweeps expired rows itself (`clearExpiredByTimeout: true`); no cron.

## Better Auth has a second, weaker limiter

Better Auth rate-limits on top of the `auth`-tier IP plugin: 60-second window, 10 requests, `/get-session` relaxed to 30 per second ([auth/auth.ts:172](../src/auth/auth.ts)). It shares only the `RATE_LIMIT_ENABLED` switch and is **in-memory**, so each instance counts separately and the DB-backed `auth` tier is what holds across replicas. A code comment tracks replacing it with a proof-of-work challenge as THU-113.

## Adding a limit to a new route

Pick an existing tier before inventing one; a new tier is a new bucket namespace and a new number to justify.

| Route shape                                          | Use                                                             |
| ---------------------------------------------------- | --------------------------------------------------------------- |
| Authenticated, spends money or calls a paid upstream | `pro`, mounted inside the auth guard                            |
| Unauthenticated, can send email or create an account | `auth`, via `createAuthIpRateLimit`                             |
| Caller is neither a session user nor usefully an IP  | `createRateLimitConsumer` with a key you compute in the handler |

A genuinely new tier goes in the `RateLimitTier` union and `tierConfigs` (`satisfies Record<RateLimitTier, RateLimitTierConfig>` makes a missing config a type error), plus the table above and the operator table in [docs/self-hosting/configuration.md](../../docs/self-hosting/configuration.md#rate-limiting-and-proxy-trust).

## Testing

Rate limiting is forced **off** for the whole backend suite (`test-setup.ts` sets `RATE_LIMIT_ENABLED=false`): `RateLimiterDrizzle` issues its own transactions, which bypass PGlite's transaction isolation and break per-test cleanup. A test that wants it constructs the middleware with `{ enabled: true }`, as [rate-limit.test.ts](../src/middleware/rate-limit.test.ts) does, and runs against the shared _isolated_ test database rather than the singleton for the same nested-transaction reason (see the comment on its `beforeAll`).
