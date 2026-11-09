# Managed Inference

Most models are bring-your-own-key: the credential lives on the device and the universal proxy forwards it ([`src/lib/proxy-fetch.ts`](../../../src/lib/proxy-fetch.ts)). **Managed inference** is the other path, where the deployment holds the credential and any signed-in user (including an anonymous session) chats unconfigured. Every managed request is priced and quota-checked before reaching an upstream; a hosted-agent run that calls tools is checked once, before its first step.

| Tier             | Route           | Credential          | What the server sees                                                            | Metering                                                   |
| ---------------- | --------------- | ------------------- | ------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| **Direct**       | `/v1/chat/*`    | `ANTHROPIC_API_KEY` | the request and the response stream                                             | backend writes the usage row itself                        |
| **Confidential** | `/v1/tinfoil/*` | `TINFOIL_API_KEY`   | neither direction; the client attests a Tinfoil enclave and HPKE-seals the body | backend writes the row from the enclave's own usage report |

Both tiers share one admission check, one price table, and one usage ledger: [`backend/src/inference/usage-ledger.ts`](../../../backend/src/inference/usage-ledger.ts).

## The shipped catalog

Three models ship as reconciled defaults in [`shared/defaults/models.ts`](../../../shared/defaults/models.ts):

| Model               | Default row (`models.ts`)      | `provider`    | Public slug           | Upstream identity                 | Route           |
| ------------------- | ------------------------------ | ------------- | --------------------- | --------------------------------- | --------------- |
| Opus 5.5            | `defaultModelOpus55`           | `thunderbolt` | `opus-5-5`            | `anthropic` / `claude-opus-5-5`   | `/v1/chat/*`    |
| DeepSeek V4.1 Flash | `defaultModelDeepSeekV41Flash` | `tinfoil`     | `deepseek-v4-1-flash` | `tinfoil` / `deepseek-v4-1-flash` | `/v1/tinfoil/*` |
| GLM 5.3             | `defaultModelGlm53`            | `tinfoil`     | `glm-5-3`             | `tinfoil` / `glm-5-3`             | `/v1/tinfoil/*` |

- **The default model is confidential.** `defaultModelId` is DeepSeek V4.1 Flash, also the cheapest: 600 / 1450 nano-USD against GLM 5.3's 1800 / 5750 and Opus 5.5's 5000 / 25000 (migrations `0034`, `0035`, `0040`).
- **`provider` is transport, not branding.** The UI shows system-managed Tinfoil rows as Thunderbolt so the vendor does not leak into the product (`models.ts:130-131`); `provider: 'tinfoil'` does not mean the user configured Tinfoil.
- **Slug and upstream identity differ on the direct tier.** `managedDirectRuntimes` ([`managed-models.ts`](../../../backend/src/inference/managed-models.ts)) maps `opus-5-5` to `internalName: 'claude-opus-5-5'`, using `Object.hasOwn` so a slug like `constructor` cannot resolve through the prototype. Pricing, usage and telemetry key on the resolved identity, hence the Opus price row `('anthropic', 'claude-opus-5-5')` against GLM's public slugs. Direct slugs have no legacy map: a client still sending `opus-5` gets `Model not found`.
- **The confidential catalog is derived.** `resolveConfidentialManagedModel` (`managed-models.ts:32-44`) filters `defaultModels` for `provider === 'tinfoil' && isConfidential === 1`, plus legacy ids `glm-5-2`, `deepseek-v4-flash` and `glm-5-3-flash` that older clients still send. A new confidential model needs no backend edit but 503s until it has a price row.

## Admission: price first, then quota

Both tiers call `checkManagedInferenceAdmission` (`usage-ledger.ts:180`) before any upstream request. Price and spend load concurrently; price failures win, so a missing price row reports configuration, not quota.

| Outcome             | Status | Body                                                               |
| ------------------- | ------ | ------------------------------------------------------------------ |
| `price-unavailable` | 503    | `{ "error": { "code": "INFERENCE_PRICE_UNAVAILABLE" } }`           |
| `quota-exceeded`    | 429    | `{ "error": { "code": "INFERENCE_QUOTA_EXCEEDED", "window": … } }` |
| `allowed`           | n/a    | request proceeds with the loaded price                             |

Bodies come from [`usage-responses.ts`](../../../backend/src/inference/usage-responses.ts) and are stable. This 429 is **not** the request rate limiter, whose body is a flat `{ error: 'Too many requests. Please try again later.' }` ([`rate-limit.ts:81`](../../../backend/src/middleware/rate-limit.ts)): body shape alone tells a spend ceiling from a request ceiling. See [rate-limiting.md](../../../backend/docs/rate-limiting.md).

### Prices are data, not code

- `inference_prices` ([`inference-usage-schema.ts:9`](../../../backend/src/db/inference-usage-schema.ts)) is keyed `(provider, model)`, nano-USD per token as `bigint` with non-negative checks. No fallback, no default: a model with no row is unbuyable.
- Rows come from [`0028_seed-inference-prices.sql`](../../../backend/drizzle/0028_seed-inference-prices.sql), [`0029_seed-glm-5-3-prices.sql`](../../../backend/drizzle/0029_seed-glm-5-3-prices.sql) and [`0033_seed-fireworks-prices.sql`](../../../backend/drizzle/0033_seed-fireworks-prices.sql).
- **A new managed model needs a price migration** and its `backend/drizzle/meta/_journal.json` entry. Drizzle finds migrations through the journal; an unlisted SQL file never runs.
- Catalog in TypeScript, prices in Postgres, so drift runs one way: the model ships, the price does not, every request 503s.
- The live Tinfoil rows are Tinfoil's list prices. `0029` and `0034` first seeded GLM 5.3 and DeepSeek V4.1 Flash with the weights of the models they replaced; `0040` moves them to Tinfoil's list prices (`1800 / 5750` and `600 / 1450`) and sets their cached-input rates (`450` and `10`), so the quota counts what Tinfoil charges. It changes a row only while it still holds the seeded weight. The retired `glm-5-2`, `deepseek-v4-flash` and `glm-5-3-flash` rows keep their weights.
- The Fireworks rows (0033, 0037) are Fireworks' Standard list prices. With `AGENT_FIREWORKS_SERVICE_TIER=priority`, the hosted agent records each reply at the stored price times the model's Priority surcharge (1.25x GLM 5.3, 1.5x MiniMax M3; [`pricing.ts`](../../../backend/src/hosted-agent/pricing.ts)), so the 5 h and 7 d caps bound real spend. All managed models draw on the same allowance.
- The tier is a multiplier rather than its own row because `inference_prices` is keyed `(provider, model)` and the tier is a deployment setting, not a property of the model.
- `calculateInferenceCost` (`usage-ledger.ts:101`) applies Anthropic's cache-write multipliers (5-minute ×1.25, 1-hour ×2) only when `provider === 'anthropic'`. Cache reads bill at the row's nullable `cache_read_nano_usd_per_token` when it is set, for any provider; a null rate falls back to ×0.1 of input for Anthropic and to the full input rate for everyone else. Migration `0037` sets it for the two Fireworks rows and `0040` for the two Tinfoil rows; the Anthropic rows leave it null.
- Cache tokens above the prompt-token total, or a cost above Postgres `bigint` max, throw (`InferenceTokenCountOutOfRangeError` / `InferenceCostOverflowError`).

### The two rolling windows

Defaults, overridden by the `INFERENCE_QUOTA_*` knobs:

| Window | Anonymous session | Registered account |
| ------ | ----------------- | ------------------ |
| 5 h    | 10¢               | 1500¢              |
| 7 d    | 60¢               | 7500¢              |

- `checkInferenceQuota` (`usage-ledger.ts:150`) sums `inference_usage.cost_nano_usd` over both windows in one aggregate using Postgres's own `now()`, keeping windows consistent across replicas.
- Limits are integer cents, split anonymous from registered (`getInferenceQuotaLimits`, `usage-ledger.ts:207`), because anonymous sessions are free to create. Knobs: [configuration.md](../../self-hosting/configuration.md#managed-inference-quotas).
- The ledger insert is idempotent on the event id (`onConflictDoNothing`, `usage-ledger.ts:143`), returning `'inserted'` or `'duplicate'`. A replayed write cannot double-charge, which is what lets `createUsageCallbacks` retry a failed insert twice, after 100 ms and 500 ms, with the same id. A third failure is logged and the run is not charged.

## Direct tier: `/v1/chat/*`

| Route                       | Shape              | Notes                                                                                                             |
| --------------------------- | ------------------ | ----------------------------------------------------------------------------------------------------------------- |
| `POST /v1/chat/completions` | OpenAI             | streaming only                                                                                                    |
| `POST /v1/chat/v1/messages` | Anthropic Messages | streaming only; Zod-validated, Anthropic-specific fields passed through as `unknown` for the upstream to validate |

[`backend/src/inference/routes.ts`](../../../backend/src/inference/routes.ts) mounts both under `prefix: '/chat'`; `/v1` comes from the app mount in `backend/src/index.ts`. Both sit behind `createMeteredRouteGuard` ([`metered-route-guard.ts`](../../../backend/src/inference/metered-route-guard.ts)), the guard in front of every managed-inference route: a session, personal access tokens allowed, the CLI device binding, then the `inference` rate limit. Only slugs in `managedDirectRuntimes` are accepted, today `opus-5-5`.

- Messages adds request-level `cache_control: { type: 'ephemeral' }` to the upstream body; Anthropic moves that breakpoint to the last cacheable block each turn, coexisting with the Pi harness's per-block breakpoints.
- `sanitizeMessageRoles` downgrades `developer` and `system` to `user` on the completions route for every message but the first, blocking a smuggled second system prompt. Messages needs no equivalent: its system prompt is a separate field.
- `createUsageCallbacks` ([`managed-request.ts`](../../../backend/src/inference/managed-request.ts)) writes the ledger row at the admitted price in the SSE `onUsage`; `onUsageMissing` / `onUsageError` log upstreams with no usage block. The hosted agent drives the same callbacks from the AI SDK's `onFinish` through `recordLanguageModelUsage`. A run that a client disconnect or its upstream timeout aborts usually ends before the provider's final usage chunk (Fireworks reports usage only there), so it is billed by estimate once the stream settles (`getAbortedRunCounts`, [`hosted-agent/usage-estimate.ts`](../../../backend/src/hosted-agent/usage-estimate.ts)). The steps it finished are billed at the usage they reported, from the `steps` `onAbort` receives; only the step in flight is estimated. A step stays in flight until its tool calls settle, so an abort while a tool runs estimates the step that called it. The estimate counts one token per Han, Hiragana, Katakana or Hangul code point plus `ceil(chars / 3)` of the remaining text. For prompt tokens it reads the system prompt, the tool definitions (none for the final step, which offers no tools and carries the final-step nudge instead) and the JSON-serialized messages, earlier steps' tool calls and results included; for completion tokens, the text, reasoning and tool-call input that step streamed. Cache tokens are zero. Three characters a token rather than the usual four errs high for alphabetic text, and CJK, which tokenizes at roughly one token per one to one and a half characters, is counted one for one so it is not undercharged up to threefold; either way a client that aborts every run cannot spend past its quota. A run whose later step fails upstream reports no total, so it is billed at what its finished steps reported (`getSettledRunCounts`). If the abort lands after the run's last step and the provider's usage arrived, that is billed instead, once. `inference_usage` has no column marking an estimated row; the `agent_usage_estimated` log line (reason, prompt and completion counts) is the only record that a row is one.
- Telemetry is body-free: status, model, provider, error kind, token counts, never content (`posthog-privacy.test.ts` pins this).
- **Client routing.** Managed rows with `vendor: 'anthropic'` route to Messages (`src/acp/built-in-adapter.ts:449`) via `resolveManagedAnthropicConnection` ([`src/ai/fetch.ts:328`](../../../src/ai/fetch.ts)), shared by the legacy AI-SDK path and the Pi harness so they cannot drift. It deletes the `x-api-key` the Anthropic SDK insists on writing and re-sends the value as `Authorization: Bearer`: the backend authenticates the app session, not an Anthropic key. The `thunderbolt` placeholder for a missing bearer under SSO cookie auth is dropped, not promoted (`fetch.ts:272-284`).
- **No configuration pre-check here.** Without `ANTHROPIC_API_KEY`, admission passes and the client factory throws (`createManagedProviderConnection` in `client.ts`) as a 500; the confidential route answers a clean 503.

## Confidential tier: `/v1/tinfoil/*`

[`backend/src/tinfoil/routes.ts`](../../../backend/src/tinfoil/routes.ts) is a pass-through, not a client. `{ parse: 'none' }` (L550) keeps the HPKE-sealed request byte-for-byte, and the response bytes stay opaque for the frontend SDK. `GET`, `POST` and `OPTIONS` only, else 405; a missing `TINFOIL_API_KEY` is 503 `Tinfoil provider not configured`.

- **The header blocklist (L47-59) is a security boundary.** `authorization`, `x-api-key`, `host`, `cookie`, `x-app-version`, `x-app-language`, the device headers and `X-Inference-Model` are dropped before `Authorization: Bearer <TINFOIL_API_KEY>` is injected. The session credential must never reach the enclave, nor the enclave's key the client.
- **`X-Tinfoil-Enclave-Url` is client-supplied and guarded.** Tinfoil's ATC picks the enclave whose HPKE key sealed the body, so the client names it. `resolveEnclaveUrl` (L201) accepts only HTTPS `tinfoil.sh` hosts, else 400. That is the SSRF guard.
- **Upstream CORS headers are stripped (L416)**: the enclave emits a duplicated `Access-Control-Allow-Credentials: true, true` that browsers reject. The backend's own `cors()` sets the correct ones.
- **Only chat is metered**: a `POST` whose decoded upstream path is `/v1/chat/completions` (L355). A `POST` may reach only that path and the two voice paths, `/v1/audio/transcriptions` and `/v1/audio/speech` (`allowedPostPaths`, L39-43). Any other `POST`, such as `/v1/responses` or `/v1/embeddings`, gets 404 before any quota read, because it would spend the operator's key outside the quota. Voice uses the same attested route ([`thunderbolt-engine.ts`](../../../src/voice/engine/thunderbolt-engine.ts), [`audio-engine.ts:110`, `:140`](../../../src/voice/engine/audio-engine.ts)) and is forwarded with no admission check and no charge, as are `GET` and `OPTIONS`. Opening another paid path means adding it to `allowedPostPaths` and metering it.
- **The model comes from a header.** The body is sealed, so the client sends `X-Inference-Model` ([`shared/inference-usage.ts:5`](../../../shared/inference-usage.ts)). An unrecognized value is 400 before the enclave; an _absent_ one prices as `glm-5-3` (L356-359) for clients predating the header. The backend also sets `X-Tinfoil-Model` to the declared model, and the enclave rejects a sealed body that names another one.
- **The prompt-cache secret is not ours to see.** The enclave partitions its cache by a client-generated 32-byte `userCacheSecret` ([`src/lib/auth-token.ts:61`](../../../src/lib/auth-token.ts) in the app, `randomBytes(32)` in the CLI), sent to the attested enclave, never the backend.
- **A personal access token is refused by default.** `x-api-key` gets 403 `WEB_LOGIN_REQUIRED` unless `CONFIDENTIAL_API_KEYS_ENABLED=true` ([`web-session.ts:24`](../../../backend/src/inference/web-session.ts)); its JSDoc and [pat-lifecycle.md](../../../backend/docs/pat-lifecycle.md) explain why this is authorization, not cryptography. Under `CLI_DEVICE_REGISTRATION_ENABLED`, a CLI-device-grant session must also match a live, unrevoked `cli` device row or get 409 `CLI_DEVICE_NOT_BOUND` ([`cli-device.ts`](../../../backend/src/inference/cli-device.ts)), as on every route behind `createMeteredRouteGuard`. Here the guard sets `allowPersonalAccessTokens` from that flag and applies the `pro` rate limit.
- **Attestation is slow, so the pool is kept warm.** `createTinfoilKeepWarm` ([`keep-warm.ts`](../../../backend/src/tinfoil/keep-warm.ts)) issues `GET /models` every 60 s against the last-used enclave origin, no-ops without `TINFOIL_API_KEY`, and logs failures at debug without affecting availability. It uses the proxy's own transport (below), so it warms the pool real requests use. Constructed `index.ts:243`, started `:326`, stopped `:341`.

Client-side attestation and caching live in [`src/ai/tinfoil-client.ts`](../../../src/ai/tinfoil-client.ts): one cached `SecureClient` per kind (`system` keyed by cloud URL, `user` for BYOK Tinfoil keys), a 15-second bound on the SDK's non-abortable `ready()`, eviction of the failed generation only, and `isTinfoilTransportWedgedError` for failures needing a fresh client.

### Inspecting verification

The model selector includes a lock beside confidential model names. A connection privacy row between the model list and reasoning controls opens verification details in a modal; the row reflects pending, successful, and failed verification. The lock and the catalog's **Private** badge describe a model, not a completed verification. Evidence is held in memory and never synced, persisted, or attached to old messages as if it verified those responses. Identity teardown clears the SDK clients and their evidence so the next identity also gets a fresh prompt-cache namespace.

[`src/attestation/types.ts`](../../../src/attestation/types.ts) defines provider-neutral connection state, checks, and public evidence. [`store.ts`](../../../src/attestation/store.ts) scopes them to a transport and client generation. Replacing or evicting a client revokes its reporting handle, so a late verification cannot overwrite a newer connection. Managed connections are keyed by backend URL; BYOK uses a separate key.

[`tinfoil.ts`](../../../src/attestation/tinfoil.ts) adapts the SDK's public `ready()` and `reset()` lifecycle, including calls made internally during key rotation. The SDK still performs all cryptography and encrypts requests. The adapter requires `securityVerified` and successful hardware, code, measurement, and certificate-binding checks before exposing evidence or allowing `ready()` to succeed. Concurrent callers share one bounded readiness operation, including re-attestation inside `fetch()`. Failed or timed-out instances are retired and evicted. Resetting during initialization also retires the instance: the SDK cannot abort its old initialization, so reusing it would allow a late completion to overwrite newer transport state. Reusing a verified SDK document preserves its original verification time. The SDK adapter and its crypto dependencies remain lazily loaded.

To add a TEE provider, adapt its SDK at the transport boundary, publish the same state/evidence contract, and add its routing identity to [`target.ts`](../../../src/attestation/target.ts). A provider must bind the verified identity to the connection that actually carries the request; a separately verified public endpoint is insufficient. Only report checks the SDK performed. Do not infer success from a catalog flag or a server-supplied boolean.

The four checks mean hardware attestation, signed build provenance, matching measurements, and an encryption key bound to the enclave. They do not mean the source code has been audited for safety. The browser SDK encrypts request bodies to the attested router; HTTP headers and network metadata are outside that body encryption. This device verifies the router endpoint, whose attested code verifies downstream model enclaves. Verification time records when that SDK document was checked, not a fresh hardware check for every message.

**ACP boundary:** the built-in adapter runs locally and uses this observed Tinfoil transport. Remote ACP, managed ACP, and hosted HTTP agents receive the chat and control their own inference connections; the selected local model is unused for those paths. Their panel therefore explains that the execution environment is not verified on this device, even if a local Tinfoil connection has been verified. TLS or iroh encryption, and ACP `_meta` claims, do not establish enclave attestation. Future ACP support needs locally verified evidence bound to the agent connection itself before it can use the verified state. Model inference verification also does not cover external tools or MCP services.

## Confidential usage metering

The backend cannot read a sealed request or response, so it asks the enclave for a usage report. Clients send no usage.

- **Request.** After admission, the backend adds `X-Tinfoil-Request-Usage-Metrics: true` to an exact managed `POST /v1/tinfoil/v1/chat/completions` and sets `X-Tinfoil-Model` to the declared `X-Inference-Model`. The enclave answers 400 to a sealed body that names a different model. The header names are in [`usage-metrics.ts`](../../../backend/src/tinfoil/usage-metrics.ts).
- **Report.** The enclave answers with `X-Tinfoil-Usage-Metrics: prompt=…,completion=…,total=…,model=…,cost_usd=…`, as a response header for an unstreamed answer and as an HTTP trailer after a streamed one. `parseTinfoilUsageMetrics` reads the fields by name and requires `prompt`, `completion` and `total` to be safe integers. It also reads `cached_prompt_tokens`, the part of the prompt Tinfoil bills at its cached rate, when that is a valid count no larger than `prompt`.
- **Ledger.** `recordEnclaveUsage` (`tinfoil/routes.ts:122`) writes the row through the shared `createUsageCallbacks` and `recordTokenCounts`, at the price loaded at admission. It ignores Tinfoil's `cost_usd` and prices the counts from `inference_prices`, which holds Tinfoil's list prices. It logs `inference_usage_completed` (transport `tinfoil`) and `inference_usage_inserted`.
- **Missing report.** A successful chat without a usable report logs `inference_usage_missing` and writes no row. A non-2xx response is charged only when it carries a report.
- **Stop.** The backend does not abort a metered chat when the client disconnects. `relayToEnd` (`tinfoil/routes.ts:145`) reads the body to the end itself and forwards it to the client, so the trailer arrives and the whole generation is charged. A client that falls more than 1 MiB behind is disconnected instead of buffered. Only the proxy's own timeouts end the read: 30 s for headers and 60 s of idle stream. Unmetered paths still abort when the client disconnects.
- **Transport.** Bun's `fetch` drops HTTP trailers, so the proxy and the keep-warm probe use `fetchWithTrailers` ([`trailer-fetch.ts`](../../../backend/src/tinfoil/trailer-fetch.ts)), which is built on `node:http(s)`. Bun 1.3 drops trailers there too, so the backend needs Bun 1.4 or newer.

### Usage that is not charged

- Requests that start at the same time can all pass admission before any of their rows exist.
- Voice, the two `/v1/audio/*` paths, is forwarded but not metered.
- Tinfoil fees beyond tokens, such as built-in web search, are not charged, because the price comes from token counts.
- A report that never arrives, after a provider or network failure or an idle timeout, charges nothing. The backend only logs `inference_usage_missing`.
- A ledger write that still fails after its two retries charges nothing. The backend logs the error.

The CLI refuses a confidential model on a PAT before any binding (`credential.type === 'pat' && model.isConfidential === 1` throws `WEB_LOGIN_REQUIRED`, `cli/src/provider-runtime/runtime.ts:115`, `:635`) and does not fall back. Service callers: [pat-lifecycle.md](../../../backend/docs/pat-lifecycle.md#metering-for-a-service-caller).

## Model rows, keys, and the catalog

Managed and bring-your-own-key rows share the synced `models` table, so the distinction must be legible in data and not just in the UI.

| Kind               | Identifying fields                                                                              | Needs a key?                                          |
| ------------------ | ----------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| **System-managed** | `isSystem: 1`, `provider` `thunderbolt` or `tinfoil`; confidential ones add `isConfidential: 1` | no, server-authenticated                              |
| **BYOK**           | `openai`, `anthropic`, `openrouter`, `tinfoil`, `custom`                                        | yes, except `custom` (a local endpoint may need none) |

- `needsApiKey` exempts `thunderbolt` by provider and `tinfoil` only when `isSystem === 1` ([`model-policy.ts:52-60`](../../../src/settings/models/model-policy.ts)). Test Connection is narrower, skipped for `thunderbolt` alone (`:39`), the only provider with nothing to verify.
- **Keys are never in the model row.** `SharedModel` ([`shared/defaults/models.ts:18`](../../../shared/defaults/models.ts)) omits `apiKey`; keys live in `models_secrets`, a local-only SQLite table that is never synced ([`src/db/tables.ts:144`](../../../src/db/tables.ts)), LEFT-JOINed by the DAL at read time ([`src/dal/models.ts:17-25`](../../../src/dal/models.ts)). That also makes the public `/v1/config` payload structurally incapable of leaking a key.
- **Key edits are three-valued.** `ApiKeyEdit` is `keep | replace | clear`, mapping to `undefined | value | null` for the DAL (`model-policy.ts:7-15`): `undefined` keeps the stored key, `null` deletes the row. `modelApiKeyForConnection` (`:18`) resolves the key for a catalog refresh or connection test, so a test can validate a key the user typed but has not saved.
- **Catalog discovery is per provider** ([`model-catalog.ts`](../../../src/settings/models/model-catalog.ts)): Thunderbolt's derives from the shipped defaults and is never fetched, Tinfoil's loads without a key, OpenAI/OpenRouter/Anthropic need the user's key (`catalogRequiresApiKey`, `providerAutoFetchesCatalog`).

### Changing the defaults

**Bump `defaultModelsVersion`** (`models.ts:175`) on any change, including reordering, or the colocated snapshot test fails. Model profiles ride the models gate rather than carrying their own version. Contract: [AGENTS.md](../../../AGENTS.md#reconciled-defaults-and-version-bumps).

Retiring a model is a one-way door. `cleanupRemovedDefaults` soft-deletes every alive `isSystem: 1` row missing from `defaultModels` without checking for local edits (`reconcile-defaults.ts:408-418`), so customizations on a retired default are lost. That is deliberate: historical `hashModel` field-list changes made unmodified rows look edited, stranding retired system models on devices forever. User-created rows are exempt via their null `defaultHash`.

## Self-hosting

| Variable                        | Enables                                                         |
| ------------------------------- | --------------------------------------------------------------- |
| `ANTHROPIC_API_KEY`             | the direct tier (`/v1/chat/*`)                                  |
| `FIREWORKS_API_KEY`             | the hosted agent, when `AGENT_MODEL` is a Fireworks model       |
| `TINFOIL_API_KEY`               | the confidential tier (`/v1/tinfoil/*`) and the keep-warm probe |
| `TINFOIL_ENCLAVE_URL`           | enclave base URL; must include the `/v1` prefix                 |
| `CONFIDENTIAL_API_KEYS_ENABLED` | lets a PAT reach the confidential routes                        |
| `INFERENCE_QUOTA_*`             | the four rolling-window budgets                                 |

Full descriptions: [configuration.md](../../self-hosting/configuration.md#ai-provider-keys). With neither key set the three catalog rows still appear (they are client-side defaults) but every managed request fails; the deployment is BYOK-only.

`GET /v1/health/models` (token-gated, `backend/src/api/health.ts:131`) probes every `defaultModels` entry against its real upstream: one non-streaming completion, 20 s per model, three at a time, confidential ones through a freshly attested enclave. Failures report as `not-configured`, `missing-price`, `timeout`, `upstream-error` or `no-text` ([`model-probe.ts`](../../../backend/src/inference/model-probe.ts)), so the two silent failure modes above are distinguishable without reading logs.

## File map

| Path                                           | Role                                                                  |
| ---------------------------------------------- | --------------------------------------------------------------------- |
| `backend/src/inference/routes.ts`              | direct tier: `/chat/completions`, `/chat/v1/messages`                 |
| `backend/src/inference/managed-models.ts`      | public slug → upstream identity, for both tiers and the hosted agent  |
| `backend/src/inference/usage-ledger.ts`        | price lookup, cost math, rolling windows, admission, ledger insert    |
| `backend/src/inference/usage-responses.ts`     | the stable 503 / 429 bodies                                           |
| `backend/src/inference/managed-request.ts`     | admission for both tiers, and the ledger-write callbacks              |
| `backend/src/inference/metered-route-guard.ts` | session, PAT, CLI-binding and rate-limit guard for metered routes     |
| `backend/src/inference/web-session.ts`         | the PAT gate on confidential routes                                   |
| `backend/src/inference/cli-device.ts`          | CLI device-grant binding check                                        |
| `backend/src/inference/client.ts`              | upstream SDK clients and per-attempt telemetry                        |
| `backend/src/inference/model-probe.ts`         | the deep health probe                                                 |
| `backend/src/tinfoil/routes.ts`                | confidential tier: the HPKE pass-through and its metering             |
| `backend/src/tinfoil/usage-metrics.ts`         | the enclave's usage-report headers and their parser                   |
| `backend/src/tinfoil/trailer-fetch.ts`         | upstream transport that can read HTTP trailers                        |
| `backend/src/tinfoil/keep-warm.ts`             | enclave connection warm-up                                            |
| `backend/src/db/inference-usage-schema.ts`     | `inference_prices`, `inference_usage`                                 |
| `shared/inference-usage.ts`                    | the `X-Inference-Model` header name                                   |
| `shared/agent-core/confidential-model.ts`      | the confidential Pi provider (app + CLI)                              |
| `shared/defaults/models.ts`                    | the shipped catalog and its version gate                              |
| `src/ai/tinfoil-client.ts`                     | attestation lifecycle and client caching                              |
| `src/ai/fetch.ts`                              | managed connection resolution (`thunderbolt` provider, Messages path) |
| `cli/src/provider-runtime/tinfoil.ts`          | CLI confidential binding                                              |
