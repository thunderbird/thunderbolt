# Rate limiting

The backend runs its own rate limiter, independent of any edge or CDN protection in front of it. It exists because several `/v1` routes cost real money or send real email on behalf of whoever calls them — managed inference, the Exa-backed search tool, link previews, OTP send, waitlist join — and a self-hosted deployment has no edge to lean on. The limiter is Postgres-backed rather than in-process, so the budget is shared across every backend replica: a horizontally scaled deployment enforces one limit, not one per instance.

Everything lives in [backend/src/middleware/rate-limit.ts](../src/middleware/rate-limit.ts) and is wired per route group in [backend/src/index.ts](../src/index.ts). Operator-facing configuration (`RATE_LIMIT_ENABLED`, `TRUSTED_PROXY`) is documented in [docs/self-hosting/configuration.md](../../docs/self-hosting/configuration.md#rate-limiting-and-proxy-trust); this page is about how the mechanism is built and how to extend it.

## Tiers

Limits are not configurable. They are hardcoded in `tierConfigs` ([rate-limit.ts:33](../src/middleware/rate-limit.ts)) so that every deployment enforces a known floor and a misconfigured env var cannot quietly raise it.

| Tier                      | Budget       | Keyed on              | Routes                                                                                   |
| ------------------------- | ------------ | --------------------- | ---------------------------------------------------------------------------------------- |
| `inference`               | 60 / minute  | user                  | `/v1/chat/*` (managed inference)                                                         |
| `pro`                     | 100 / minute | user                  | `/v1/pro/*`, `/v1/proxy/*`, `/v1/proxy/ws`, `/v1/tinfoil/*`, `/v1/search`, `/v1/preview` |
| `receipt`                 | 100 / minute | user                  | `/v1/inference-usage/receipts`                                                           |
| `auth`                    | 10 / minute  | client IP             | `/v1/api/auth/*`, `/v1/waitlist/*`                                                       |
| `debug-transcript`        | 10 / hour    | user                  | `POST /v1/debug-transcripts`                                                             |
| `debug-transcript-intake` | 600 / hour   | intake client, and IP | `POST /v1/debug-transcripts/intake`                                                      |

The tier name is the limiter's `keyPrefix` ([rate-limit.ts:48](../src/middleware/rate-limit.ts)), and `rate-limiter-flexible` stores rows under `<keyPrefix>:<key>`. Two consequences follow, and both are load-bearing:

- **A tier is one shared bucket, however many times it is mounted.** `proRateLimit` is built once ([index.ts:90](../src/index.ts)) and passed to six route groups, so a user's 100 requests per minute are spent across the proxy, tinfoil, search and preview together — not 100 each. Likewise the two separate `createAuthIpRateLimit` calls (the Better Auth plugin at [index.ts:95](../src/index.ts) and waitlist at [index.ts:198](../src/index.ts)) build two limiter objects that share one `auth:<ip>` bucket.
- **Different tiers never interfere.** Exhausting `inference` leaves `pro` and `receipt` untouched; `rate-limit.test.ts` pins the inference/pro and inference/receipt pairs.

## The three ways to apply a tier

`createUserTierRateLimit` ([rate-limit.ts:112](../src/middleware/rate-limit.ts)) returns an Elysia plugin that keys on `user:<id>`, read from the context the auth macro already resolved — no second `getSession()` call.

`createIpTierRateLimit` ([rate-limit.ts:151](../src/middleware/rate-limit.ts)) keys on `ip:<addr>` for routes with no session yet. `createAuthIpRateLimit` is the `auth`-tier shorthand.

`createRateLimitConsumer` ([rate-limit.ts:168](../src/middleware/rate-limit.ts)) returns a plain function rather than a plugin, for the case where the key is neither the session user nor the IP. The debug-transcript intake uses it: the caller is another deployment authenticating with a client key, so the bucket has to be `client:<id>`, and it can only be computed after the handler has looked the key up ([debug-transcripts-intake.ts:66](../src/api/debug-transcripts-intake.ts)). That route is also wrapped in an IP-keyed limiter of the same tier, so an unknown caller burning 401s still hits a ceiling.

When `settings.rateLimitEnabled` is false, the two factories return a bare `new Elysia()` and the consumer factory returns `null`. Nothing downstream changes shape — the call sites treat the plugin as optional anyway.

## Placement rules that will bite you

**The user-keyed plugin must be `.use()`d _inside_ `guard({ auth: true }, …)`.** It reads `ctx.user`, which the auth macro's `resolve` populates. Registered at app level, the macro resolves _after_ `onBeforeHandle` and the middleware finds no user — and its no-user branch returns without consuming a point ([rate-limit.ts:104](../src/middleware/rate-limit.ts)), so the route is silently unlimited. Every authenticated call site follows the pattern: see [pro/routes.ts:17](../src/pro/routes.ts), [api/search.ts:37](../src/api/search.ts), [inference/routes.ts:262](../src/inference/routes.ts).

The skip-when-no-user branch is deliberate for routes where an unauthenticated request is already going to 401, but it means "mounted" and "enforcing" are not the same thing. The WebSocket proxy is the honest example: `createUniversalProxyWsRoutes` mounts `proRateLimit` at plugin level ([proxy/ws.ts:233](../src/proxy/ws.ts)) but authorises the bearer subprotocol inside `open()` ([proxy/ws.ts:289](../src/proxy/ws.ts)), so no user is resolved before the upgrade and the handshake is not user-limited.

**Better Auth is mounted with `.all('/*')`, not `.mount()`.** Elysia's `mount()` short-circuits the pipeline before `onBeforeHandle`, which would bypass the IP limiter entirely; the comment at [auth/elysia-plugin.ts:53](../src/auth/elysia-plugin.ts) records this so nobody "tidies" it back.

**IP resolution fails closed.** `extractClientIp` ([utils/request.ts](../src/utils/request.ts)) trusts a proxy header only when `TRUSTED_PROXY` names the edge — `cloudflare` → `CF-Connecting-IP`, `akamai` → `True-Client-IP` — because without a proxy in front, any client can forge `X-Forwarded-For` and mint a fresh bucket per request. When the address cannot be resolved at all, the request lands in a single shared `ip:unknown` bucket rather than skipping the limit ([rate-limit.ts:144](../src/middleware/rate-limit.ts)). Identifiable clients keep their own bucket, so the shared one only ever collects traffic nothing can attribute. The same `TRUSTED_PROXY` value feeds Better Auth's `ipAddressHeaders` via `getTrustedIpHeaders`, so both limiters agree on who the client is; that helper returns `undefined` rather than `[]` when no proxy is configured, because `[]` makes Better Auth resolve a null IP and disable its own limiter.

## Response contract

Every response that passes through a limiter carries `RateLimit-Limit`, `RateLimit-Remaining` and `RateLimit-Reset` (seconds until the window rolls). A rejection is `429` with `Retry-After`, `RateLimit-Remaining: 0`, and the body `{ "error": "Too many requests. Please try again later." }` ([rate-limit.ts:56](../src/middleware/rate-limit.ts), [rate-limit.ts:68](../src/middleware/rate-limit.ts)).

None of those header names are in `defaultCorsExposeHeaders` ([config/settings.ts:11](../src/config/settings.ts)), so browser code cannot read them cross-origin unless an operator adds them to `CORS_EXPOSE_HEADERS`. Setting that variable replaces the default list rather than appending to it, so an operator has to carry the existing values across — see the CORS section of [AGENTS.md](../../AGENTS.md) for why the expose list is explicit while the allowed-request-header list is not.

A `429` from the backend is not necessarily this limiter. Managed inference also returns `429` with `{ "error": { "code": "INFERENCE_QUOTA_EXCEEDED", "window": … } }` from [inference/usage-responses.ts](../src/inference/usage-responses.ts) when a rolling spend quota is exhausted; that is a usage ledger, not a request counter, and it has its own body shape so the client can tell the two apart.

## Storage

Counters live in the `rate_limits` table ([db/rate-limit-schema.ts](../src/db/rate-limit-schema.ts), created by `backend/drizzle/0008_known_shockwave.sql`) — a `key` primary key, a `points` counter, and an `expire` timestamp with an index on it. The schema is dictated by `rate-limiter-flexible`'s Drizzle adapter, so do not reshape it. Expired rows are swept by the limiter itself (`clearExpiredByTimeout: true`), so there is no cron to run.

## Better Auth has a second, weaker limiter

Better Auth applies its own rate limiting on top of the `auth`-tier IP plugin: 60-second window, 10 requests, with `/get-session` relaxed to 30 per second ([auth/auth.ts:172](../src/auth/auth.ts)). It shares the `RATE_LIMIT_ENABLED` switch but nothing else — it is **in-memory**, so in a horizontally scaled deployment each instance counts separately and it provides single-instance defence only. The DB-backed `auth` tier is what actually holds across replicas. Replacing the in-memory layer with a proof-of-work challenge is tracked as THU-113 in the code comment.

## Adding a limit to a new route

Pick an existing tier before inventing one; a new tier is a new bucket namespace and a new number to justify. In practice:

- Authenticated route that spends money or calls a paid upstream → `pro`, mounted inside the auth guard.
- Unauthenticated route that can send email or create an account → `auth`, via `createAuthIpRateLimit`.
- A caller that is neither a session user nor usefully an IP → `createRateLimitConsumer` with a key you compute in the handler.

If a genuinely new tier is warranted, add it to the `RateLimitTier` union and `tierConfigs`; `satisfies Record<RateLimitTier, RateLimitTierConfig>` makes the missing config a type error. Add it to the table above and to the operator table in [docs/self-hosting/configuration.md](../../docs/self-hosting/configuration.md#rate-limiting-and-proxy-trust).

## Testing

Rate limiting is forced **off** for the whole backend suite: `test-setup.ts` sets `RATE_LIMIT_ENABLED=false` because `RateLimiterDrizzle` issues its own transactions, which bypass PGlite's transaction isolation and break per-test cleanup. A test that wants the limiter must opt in by constructing the middleware with `{ enabled: true }` itself, as [rate-limit.test.ts](../src/middleware/rate-limit.test.ts) does. That suite also runs against the shared _isolated_ test database rather than the usual singleton, for the same nested-transaction reason — the comment on its `beforeAll` explains what happens if you use the singleton instead.
