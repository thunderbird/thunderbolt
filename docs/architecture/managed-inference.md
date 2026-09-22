# Managed Inference

Most models in Thunderbolt are bring-your-own-key: the credential lives on the device, and the universal proxy only maps headers and forwards the caller's own key ([`src/lib/proxy-fetch.ts`](../../src/lib/proxy-fetch.ts)). **Managed inference** is the other path — the deployment holds the provider credential, so a signed-in user (including an anonymous session) can chat without configuring anything. Because the deployment is paying, every managed request is priced and quota-checked before it reaches an upstream.

There are two managed tiers, and the difference between them is what the server can see:

- **Direct** — the backend calls Anthropic with `ANTHROPIC_API_KEY`, reads the response stream, and writes the usage row itself.
- **Confidential** — the client attests a Tinfoil enclave and HPKE-seals the request body; the backend is a pass-through that cannot read either direction. Metering therefore cannot happen server-side, and runs instead on a signed receipt the client posts back after decrypting the response.

Both tiers share one admission check, one price table, and one usage ledger. That shared core is [`backend/src/inference/usage-ledger.ts`](../../backend/src/inference/usage-ledger.ts).

## The shipped catalog

Three models ship as reconciled defaults in [`shared/defaults/models.ts`](../../shared/defaults/models.ts):

| Model         | Default row (`models.ts`)      | `provider`    | Public slug     | Upstream identity             | Route           |
| ------------- | ------------------------------ | ------------- | --------------- | ----------------------------- | --------------- |
| Opus 5        | `defaultModelOpus5`, L85       | `thunderbolt` | `opus-5`        | `anthropic` / `claude-opus-5` | `/v1/chat/*`    |
| GLM 5.3 Flash | `defaultModelGlm53Flash`, L105 | `tinfoil`     | `glm-5-3-flash` | `tinfoil` / `glm-5-3-flash`   | `/v1/tinfoil/*` |
| GLM 5.3       | `defaultModelGlm53`, L127      | `tinfoil`     | `glm-5-3`       | `tinfoil` / `glm-5-3`         | `/v1/tinfoil/*` |

`defaultModelId` (`models.ts:125`) is GLM 5.3 Flash, so a new account's default model is a confidential one — and the cheapest of the three per token: 300 / 700 nano-USD against GLM 5.3's 1500 / 5250 and Opus 5's 5000 / 25000 (migrations `0028` and `0029`, below).

The `provider` column is the internal transport, not branding: the UI presents system-managed Tinfoil rows as Thunderbolt so the infrastructure vendor does not leak into the product (comment at `models.ts:130-131`). Do not read `provider: 'tinfoil'` as "the user configured Tinfoil".

**Public slug and upstream identity are deliberately different on the direct tier.** `managedDirectRuntimes` ([`managed-models.ts:17`](../../backend/src/inference/managed-models.ts)) maps the public slug `opus-5` to `internalName: 'claude-opus-5'`, and the lookup uses `Object.hasOwn` so a slug like `constructor` cannot resolve through the prototype. Everything downstream — pricing, the usage row, telemetry — keys on the resolved identity, which is why the Opus price row is `('anthropic', 'claude-opus-5')` while the GLM rows key on their public slug.

The confidential catalog is _derived_, not listed: `resolveConfidentialManagedModel` (`managed-models.ts:32-44`) filters `defaultModels` for `provider === 'tinfoil' && isConfidential === 1` and adds two legacy ids (`glm-5-2`, `deepseek-v4-flash`) that older clients still send. Adding a confidential model to `defaultModels` therefore makes the backend accept it with no backend edit — but it will 503 until it has a price row.

## Admission: price first, then quota

Both tiers call `checkManagedInferenceAdmission` (`usage-ledger.ts:157`) before any upstream request. It loads the price and the rolling spend concurrently, and price failures take precedence so a deployment with a missing price row reports a configuration problem rather than a quota problem.

| Outcome             | Status | Body                                                               |
| ------------------- | ------ | ------------------------------------------------------------------ |
| `price-unavailable` | 503    | `{ "error": { "code": "INFERENCE_PRICE_UNAVAILABLE" } }`           |
| `quota-exceeded`    | 429    | `{ "error": { "code": "INFERENCE_QUOTA_EXCEEDED", "window": … } }` |
| `allowed`           | —      | request proceeds with the loaded price                             |

Both bodies come from [`usage-responses.ts`](../../backend/src/inference/usage-responses.ts) and are stable. The 429 here is **not** the request rate limiter, whose 429 carries a flat `{ error: 'Too many requests. Please try again later.' }` ([`rate-limit.ts:81`](../../backend/src/middleware/rate-limit.ts)) — so a client can tell a spend ceiling from a request ceiling by body shape alone. See [rate-limiting.md](../../backend/docs/rate-limiting.md).

### Prices are data, not code

`inference_prices` ([`backend/src/db/inference-usage-schema.ts:9`](../../backend/src/db/inference-usage-schema.ts)) is keyed on `(provider, model)` and stores nano-USD per token as `bigint`, with non-negative check constraints. There is no fallback price and no default: a model with no row is unbuyable.

Rows exist only because two migrations insert them — [`0028_seed-inference-prices.sql`](../../backend/drizzle/0028_seed-inference-prices.sql) and [`0029_seed-glm-5-3-prices.sql`](../../backend/drizzle/0029_seed-glm-5-3-prices.sql). The catalog lives in TypeScript and the prices live in the database, so the two can drift in exactly one direction: a model ships, its price does not, and every request for it answers 503. **A new managed model needs a migration that inserts its price**, and that migration needs its entry in `backend/drizzle/meta/_journal.json` — Drizzle discovers pending migrations through the journal, so a SQL file it does not list never runs.

The stored numbers are a quota weighting, not a billing record. Migration 0029 sets GLM 5.3 to `1500 / 5250` — glm-5-2's numbers rather than Tinfoil's list prices of `1800 / 5750` — deliberately, so a model swap does not silently change how fast users burn their allowance.

`calculateInferenceCost` (`usage-ledger.ts:78`) applies Anthropic's prompt-cache multipliers (5-minute write ×1.25, 1-hour write ×2, cache read ×0.1) and only when `provider === 'anthropic'`; the confidential receipt contract carries no cache fields to apply them to ([`shared/inference-usage.ts:9`](../../shared/inference-usage.ts)). Cache tokens that exceed the prompt-token total, or a cost above the Postgres `bigint` maximum, throw (`InferenceTokenCountOutOfRangeError` / `InferenceCostOverflowError`) rather than record something wrong.

### The two rolling windows

`checkInferenceQuota` (`usage-ledger.ts:127`) sums `inference_usage.cost_nano_usd` over the last 5 hours and the last 7 days in a single aggregate query, using Postgres's own `now()`. Using the database clock rather than the process clock is what keeps the windows consistent across horizontally scaled replicas.

Limits are integer cents and split anonymous from registered (`getInferenceQuotaLimits`, `usage-ledger.ts:184`): an anonymous session gets 10¢ / 60¢ by default against a registered account's 1500¢ / 7500¢, because an anonymous session costs an attacker nothing to create. The four `INFERENCE_QUOTA_*` knobs are documented in [configuration.md](../self-hosting/configuration.md#managed-inference-quotas).

The ledger insert is idempotent on the event id (`onConflictDoNothing`, `usage-ledger.ts:120`) and returns `'inserted'` or `'duplicate'`. That is what makes receipt retries safe.

## Direct tier — `/v1/chat/*`

[`backend/src/inference/routes.ts`](../../backend/src/inference/routes.ts) mounts two routes under `prefix: '/chat'` (L250); the `/v1` comes from the app mount in `backend/src/index.ts`.

- `POST /v1/chat/completions` (L270) — OpenAI-shaped, streaming only.
- `POST /v1/chat/v1/messages` (L390) — Anthropic Messages-shaped, streaming only, Zod-validated with the Anthropic-specific fields passed through as `unknown` for the upstream API to validate.

Both accept only slugs present in `managedDirectRuntimes`, which today means `opus-5` alone. The Messages route adds request-level `cache_control: { type: 'ephemeral' }` (L462-464) — Anthropic moves that breakpoint to the last cacheable block each turn, and it coexists with the explicit per-block breakpoints the Pi harness sets.

On the completions route, `sanitizeMessageRoles` (L67-69) downgrades `developer` and `system` roles to `user` for every message except the first, so a caller cannot smuggle a second system prompt into the conversation. The Messages route has no equivalent: there the system prompt is a separate `system` field rather than a role in the message array.

Usage is recorded from the stream: `createUsageCallbacks` (L163) writes the ledger row in the SSE stream's `onUsage`, and `onUsageMissing` / `onUsageError` log the cases where an upstream returned no usage block. Telemetry throughout is body-free by construction — status, model, provider, error kind and token counts only, never prompt or response content (`posthog-privacy.test.ts` pins this).

On the client, a managed row with `vendor: 'anthropic'` is routed to the Messages endpoint (`src/acp/built-in-adapter.ts:449`) through `resolveManagedAnthropicConnection` ([`src/ai/fetch.ts:328`](../../src/ai/fetch.ts)), which deletes the `x-api-key` header the Anthropic SDK insists on writing and re-sends its value as `Authorization: Bearer` (the `thunderbolt` placeholder that stands in for a missing bearer under SSO cookie auth is dropped rather than promoted, `fetch.ts:272-284`). The backend authenticates the app session, not an Anthropic key, and the same helper serves both the legacy AI-SDK path and the Pi harness so they cannot drift.

There is no configuration pre-check on this tier: with `ANTHROPIC_API_KEY` unset, admission still passes and the client constructor throws (`client.ts:297`), surfacing as a 500. The confidential route, by contrast, answers a clean 503.

## Confidential tier — `/v1/tinfoil/*`

[`backend/src/tinfoil/routes.ts`](../../backend/src/tinfoil/routes.ts) is a pass-through, not a client. `{ parse: 'none' }` (L460) leaves the request stream untouched so the HPKE-sealed body reaches the enclave byte-for-byte, and `decompress: false` (L312) keeps the response bytes opaque so the frontend SDK can decrypt them as-is. The route handles `GET`, `POST` and `OPTIONS`; anything else is 405, and a missing `TINFOIL_API_KEY` is 503 `Tinfoil provider not configured`.

Things worth knowing before touching this file:

- **The header blocklist (L41-53) is a security boundary.** `authorization`, `x-api-key`, `host`, `cookie`, `x-app-version`, `x-app-language`, the device headers and `X-Inference-Model` are all dropped before `Authorization: Bearer <TINFOIL_API_KEY>` is injected. The app's own session credential must never reach the enclave, and the enclave's key must never reach the client.
- **`X-Tinfoil-Enclave-Url` is client-supplied and guarded.** Tinfoil's ATC assigns the enclave whose HPKE key sealed the body, so the client has to say where to send it; `resolveEnclaveUrl` (L105) accepts only HTTPS `tinfoil.sh` hosts and answers 400 otherwise. That check is the SSRF guard.
- **Upstream CORS headers are stripped (L317-326)** because the enclave emits a duplicated `Access-Control-Allow-Credentials: true, true` that browsers reject outright; the backend's own `cors()` middleware sets the correct ones.
- **Only chat is metered.** A request is admitted and receipted only when it is a `POST` whose decoded upstream path is `/v1/chat/completions` (L244-245). The same proxy also carries voice: STT and TTS run in the enclave over `/audio/transcriptions` and `/audio/speech` ([`audio-engine.ts:110`, `:140`](../../src/voice/engine/audio-engine.ts)), reached through the same attested `/tinfoil` route ([`thunderbolt-engine.ts`](../../src/voice/engine/thunderbolt-engine.ts)) and neither quota-checked nor charged. Adding another metered enclave path means extending that condition, not just the client.
- **The model is knowable only from a header.** The body is sealed, so the client declares the model in `X-Inference-Model` ([`shared/inference-usage.ts:5`](../../shared/inference-usage.ts)). An unrecognized value is 400 before anything reaches the enclave; an _absent_ header is priced as `glm-5-3` (L247-249) to keep clients that predate the header working.
- **The prompt-cache secret is not ours to see.** The enclave partitions its prompt cache by a client-generated 32-byte `userCacheSecret` ([`src/lib/auth-token.ts:61`](../../src/lib/auth-token.ts) in the app, `randomBytes(32)` in the CLI). It goes to the attested enclave and never to the backend.
- **A personal access token is refused by default.** `x-api-key` on the confidential routes gets 403 `WEB_LOGIN_REQUIRED` unless `CONFIDENTIAL_API_KEYS_ENABLED=true` ([`web-session.ts:24`](../../backend/src/inference/web-session.ts)). The JSDoc there and [pat-lifecycle.md](../../backend/docs/pat-lifecycle.md) explain why this is an authorization choice rather than a cryptographic one. Where `CLI_DEVICE_REGISTRATION_ENABLED` is on, a CLI-device-grant session is additionally checked against a live, unrevoked `cli` device row and gets 409 `CLI_DEVICE_NOT_BOUND` otherwise ([`cli-device.ts`](../../backend/src/inference/cli-device.ts)); the same guard runs on `/v1/chat/*` and the receipt route.
- **Attestation is slow, so the pool is kept warm.** `createTinfoilKeepWarm` ([`keep-warm.ts`](../../backend/src/tinfoil/keep-warm.ts)) issues a `GET /models` every 60 seconds against the most recently used enclave origin, is a no-op without `TINFOIL_API_KEY`, and its failures are logged at debug and never affect availability. It is constructed at `index.ts:215`, started at `:259` and stopped at `:274`.

On the client side, attestation lifecycle and caching live in [`src/ai/tinfoil-client.ts`](../../src/ai/tinfoil-client.ts): one cached `SecureClient` per kind (`system` keyed by cloud URL, `user` for BYOK Tinfoil keys), a 15-second bound on the SDK's non-abortable `ready()`, eviction of the failed generation only, and `isTinfoilTransportWedgedError` for the SDK failure modes that require a fresh client.

## Usage receipts

A receipt is the backend telling itself, through the client, what it already decided. It is issued at admission time on the confidential tier and returned on the response, and the client posts it back with the token counts it read out of the decrypted stream.

**Format** ([`usage-receipt.ts`](../../backend/src/inference/usage-receipt.ts)): `iu1.<base64url claims>.<hmac>`. The HMAC key is derived from `BETTER_AUTH_SECRET` under a domain string (`thunderbolt/inference-usage-receipt/key/v1`, L18, L42-45), so the receipt key is not the session key. Signed claims are `eventId`, `userId`, `provider`, `model` and both per-token prices, plus `issuedAt`/`expiresAt`; the lifetime is two hours (L19) and 60 seconds of future skew is tolerated (L20, L107). Verification is constant-time and re-validates the claim schema after the signature, including that the model is still a recognized confidential one.

**The token counts are not signed.** They cannot be — the client is the only party that can read the enclave's response. The resulting trust model is worth stating plainly: the server fixes _who_, _what_ and _at what price_; the client reports _how much_. A client can under-report its own usage; it cannot bill another account (a `userId` mismatch is 403, `usage-receipt-routes.ts:114`) and it cannot invent a price.

**Transport.** The receipt travels in the `X-Inference-Usage-Receipt` response header, set only when the upstream succeeded — and the same header name is stripped from the upstream headers first (`tinfoil/routes.ts:321-328`), so the enclave cannot forge one. The header is listed in `defaultCorsExposeHeaders` (`backend/src/config/settings.ts:11`): browsers expose only listed headers cross-origin, so removing it there would silently stop all browser-side metering.

**`POST /v1/inference-usage/receipts`** ([`usage-receipt-routes.ts`](../../backend/src/inference/usage-receipt-routes.ts)) parses the body by hand under `parse: 'none'` with a 4096-byte cap, and every response is body-free:

| Status | Meaning                                                              |
| ------ | -------------------------------------------------------------------- |
| 204    | stored, or a duplicate `eventId` (replays are deduplicated)          |
| 400    | malformed, expired, or out-of-range submission — never becomes valid |
| 403    | the receipt belongs to another account                               |
| 503    | transient storage failure — retry                                    |

**Correlation is shared between the app and the CLI.** [`shared/agent-core/confidential-model.ts`](../../shared/agent-core/confidential-model.ts) wraps the Pi provider at the stream seam: it captures the receipt header via `onResponse`, stages it against the exact terminal assistant message, and submits only if that message is the one the harness ends with and did not error or abort (L139-149, L266-314). Token counts are mapped as `promptTokens = input + cacheRead + cacheWrite`, and any non-safe-integer count drops the submission instead of sending nonsense.

**Delivery is where the two clients differ, and it is not cosmetic:**

- The app fires the POST through the authenticated `HttpClient` with a 3-second timeout and logs failures ([`src/ai/inference-usage-receipt.ts`](../../src/ai/inference-usage-receipt.ts), wired at `src/acp/built-in-adapter.ts:381`). There is no queue: a crash between completion and POST loses that usage.
- The CLI spools to a durable outbox at `$THUNDERBOLT_HOME/inference-usage-receipts/<deviceId>.json` (`~/.thunderbolt/…` by default), written `0600` under a file lock _before_ the first attempt and removed only once acknowledged ([`cli/src/provider-runtime/usage-receipt.ts`](../../cli/src/provider-runtime/usage-receipt.ts), L100-137; path at [`cli/src/provider-runtime/tinfoil.ts:108`](../../cli/src/provider-runtime/tinfoil.ts)). Each attempt gets a 3-second timeout and two retries at 100 ms and 500 ms, and the outbox is flushed at the start of the next confidential run. Failures are classified rather than blanket-retried (L161-181): 429 and 5xx retry, 403 discards (it can never succeed for this account), 401 retains the receipt and triggers `onStoredSessionRejected`, anything else is retained for later.

The CLI also refuses a confidential model on a PAT before preparing any binding — `credential.type === 'pat' && model.isConfidential === 1` throws `WEB_LOGIN_REQUIRED` (`cli/src/provider-runtime/runtime.ts:115`, `:634`) — and does not fall back to another provider. A service caller that wants to implement the receipt loop by hand will find the curl recipe and the failure dispositions in [pat-lifecycle.md](../../backend/docs/pat-lifecycle.md#reporting-usage-from-a-service-caller).

## Model rows, keys, and the catalog

Managed rows and bring-your-own-key rows live in the same synced `models` table, which is why the distinction has to be legible in data and not just in the UI.

`SharedModel` ([`shared/defaults/models.ts:18`](../../shared/defaults/models.ts)) deliberately omits `apiKey`. Keys live in `models_secrets`, a local-only SQLite table that is never synced ([`src/db/tables.ts:144`](../../src/db/tables.ts)), and the model DAL LEFT-JOINs it at read time ([`src/dal/models.ts:17-25`](../../src/dal/models.ts)). The omission also makes the public `/v1/config` payload structurally incapable of leaking a key.

- **System-managed** rows have `isSystem: 1` and `provider` `thunderbolt` or `tinfoil`; confidential ones additionally carry `isConfidential: 1`. They are server-authenticated, so `needsApiKey` exempts both — `thunderbolt` by provider and `tinfoil` only when `isSystem === 1` ([`src/settings/models/model-policy.ts:52-60`](../../src/settings/models/model-policy.ts)). The add-model form's Test Connection gate is narrower: it is skipped for `thunderbolt` alone (`:39`), since that is the only provider with nothing to verify.
- **BYOK** rows (`openai`, `anthropic`, `openrouter`, `tinfoil`, `custom`) require a key, except `custom`, where a local endpoint may need none.

Key edits are three-valued, not two: `ApiKeyEdit` is `keep | replace | clear`, mapping to `undefined | value | null` for the DAL (`model-policy.ts:7-15`) — `undefined` leaves the stored key alone, `null` deletes the row. `modelApiKeyForConnection` (`:18`) resolves the key used for an explicit catalog refresh or connection test, which is why a test can validate a key the user typed but has not saved.

Catalog discovery is per provider ([`src/settings/models/model-catalog.ts`](../../src/settings/models/model-catalog.ts)): the Thunderbolt catalog is derived from the shipped defaults and never fetched, Tinfoil's loads without a key, and OpenAI/OpenRouter/Anthropic listings need the user's key (`catalogRequiresApiKey`, `providerAutoFetchesCatalog`).

Defaults are reconciled, so changing this file has a protocol: **bump `defaultModelsVersion`** (`models.ts:175`) on any change, including reordering, or the colocated snapshot test fails. Retiring a model is a one-way door: `cleanupRemovedDefaults` soft-deletes every alive `isSystem: 1` row whose id is no longer in `defaultModels`, without checking whether the local copy was edited (`reconcile-defaults.ts:408-418`). That is deliberate — historical `hashModel` field-list changes made unmodified rows look edited, which left retired system models stuck on user devices forever, so a user who customized a retired default loses those tweaks. User-created rows are exempt because they carry a null `defaultHash`. Model profiles ride the models gate rather than carrying their own version. The reconciliation contract is documented in [AGENTS.md](../../AGENTS.md#reconciled-defaults-and-version-bumps).

## Self-hosting

| Variable                        | Enables                                                         |
| ------------------------------- | --------------------------------------------------------------- |
| `ANTHROPIC_API_KEY`             | the direct tier (`/v1/chat/*`)                                  |
| `TINFOIL_API_KEY`               | the confidential tier (`/v1/tinfoil/*`) and the keep-warm probe |
| `TINFOIL_ENCLAVE_URL`           | enclave base URL; must include the `/v1` prefix                 |
| `CONFIDENTIAL_API_KEYS_ENABLED` | lets a PAT reach the confidential routes                        |
| `INFERENCE_QUOTA_*`             | the four rolling-window budgets                                 |

With neither provider key set, the three catalog rows still appear in the app — they are client-side defaults — but every managed request fails. A deployment in that state is BYOK-only. Full descriptions live in [configuration.md](../self-hosting/configuration.md#ai-provider-keys).

`GET /v1/health/models` (token-gated, `backend/src/api/health.ts:131`) probes every model in `defaultModels` against its real upstream: one non-streaming completion each, 20 seconds per model, three at a time, with the confidential models going through a freshly attested enclave. It reports which model failed and why — `not-configured`, `missing-price`, `timeout`, `upstream-error` or `no-text` ([`model-probe.ts`](../../backend/src/inference/model-probe.ts)) — so the two silent failure modes above (no key, no price row) are distinguishable without reading logs.

## File map

| Path                                            | Role                                                                  |
| ----------------------------------------------- | --------------------------------------------------------------------- |
| `backend/src/inference/routes.ts`               | direct tier: `/chat/completions`, `/chat/v1/messages`                 |
| `backend/src/inference/managed-models.ts`       | public slug → upstream identity, for both tiers                       |
| `backend/src/inference/usage-ledger.ts`         | price lookup, cost math, rolling windows, admission, ledger insert    |
| `backend/src/inference/usage-responses.ts`      | the stable 503 / 429 bodies                                           |
| `backend/src/inference/usage-receipt.ts`        | receipt issue and verify                                              |
| `backend/src/inference/usage-receipt-routes.ts` | `POST /v1/inference-usage/receipts`                                   |
| `backend/src/inference/web-session.ts`          | the PAT gate on confidential routes                                   |
| `backend/src/inference/cli-device.ts`           | CLI device-grant binding check                                        |
| `backend/src/inference/client.ts`               | upstream SDK clients and per-attempt telemetry                        |
| `backend/src/inference/model-probe.ts`          | the deep health probe                                                 |
| `backend/src/tinfoil/routes.ts`                 | confidential tier: the HPKE pass-through and its metering hook        |
| `backend/src/tinfoil/keep-warm.ts`              | enclave connection warm-up                                            |
| `backend/src/db/inference-usage-schema.ts`      | `inference_prices`, `inference_usage`                                 |
| `shared/inference-usage.ts`                     | the two header names and the receipt request shape                    |
| `shared/agent-core/confidential-model.ts`       | receipt capture and terminal-message correlation (app + CLI)          |
| `shared/defaults/models.ts`                     | the shipped catalog and its version gate                              |
| `src/ai/tinfoil-client.ts`                      | attestation lifecycle and client caching                              |
| `src/ai/inference-usage-receipt.ts`             | the app's receipt POST                                                |
| `src/ai/fetch.ts`                               | managed connection resolution (`thunderbolt` provider, Messages path) |
| `cli/src/provider-runtime/tinfoil.ts`           | CLI confidential binding                                              |
| `cli/src/provider-runtime/usage-receipt.ts`     | CLI receipt outbox and retry policy                                   |
