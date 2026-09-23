# Managed Inference

Most models are bring-your-own-key: the credential lives on the device and the universal proxy forwards it ([`src/lib/proxy-fetch.ts`](../../src/lib/proxy-fetch.ts)). **Managed inference** is the other path, where the deployment holds the credential and any signed-in user (including an anonymous session) chats unconfigured. Every managed request is priced and quota-checked before reaching an upstream.

| Tier             | Route           | Credential          | What the server sees                                                            | Metering                                                |
| ---------------- | --------------- | ------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------- |
| **Direct**       | `/v1/chat/*`    | `ANTHROPIC_API_KEY` | the request and the response stream                                             | backend writes the usage row itself                     |
| **Confidential** | `/v1/tinfoil/*` | `TINFOIL_API_KEY`   | neither direction; the client attests a Tinfoil enclave and HPKE-seals the body | a signed receipt the client posts back after decrypting |

Both tiers share one admission check, one price table, and one usage ledger: [`backend/src/inference/usage-ledger.ts`](../../backend/src/inference/usage-ledger.ts).

## The shipped catalog

Three models ship as reconciled defaults in [`shared/defaults/models.ts`](../../shared/defaults/models.ts):

| Model         | Default row (`models.ts`)      | `provider`    | Public slug     | Upstream identity             | Route           |
| ------------- | ------------------------------ | ------------- | --------------- | ----------------------------- | --------------- |
| Opus 5        | `defaultModelOpus5`, L85       | `thunderbolt` | `opus-5`        | `anthropic` / `claude-opus-5` | `/v1/chat/*`    |
| GLM 5.3 Flash | `defaultModelGlm53Flash`, L105 | `tinfoil`     | `glm-5-3-flash` | `tinfoil` / `glm-5-3-flash`   | `/v1/tinfoil/*` |
| GLM 5.3       | `defaultModelGlm53`, L127      | `tinfoil`     | `glm-5-3`       | `tinfoil` / `glm-5-3`         | `/v1/tinfoil/*` |

- **The default model is confidential.** `defaultModelId` (`models.ts:125`) is GLM 5.3 Flash, also the cheapest: 300 / 700 nano-USD against GLM 5.3's 1500 / 5250 and Opus 5's 5000 / 25000 (migrations `0028`, `0029`).
- **`provider` is transport, not branding.** The UI shows system-managed Tinfoil rows as Thunderbolt so the vendor does not leak into the product (`models.ts:130-131`); `provider: 'tinfoil'` does not mean the user configured Tinfoil.
- **Slug and upstream identity differ on the direct tier.** `managedDirectRuntimes` ([`managed-models.ts:17`](../../backend/src/inference/managed-models.ts)) maps `opus-5` to `internalName: 'claude-opus-5'`, using `Object.hasOwn` so a slug like `constructor` cannot resolve through the prototype. Pricing, usage and telemetry key on the resolved identity, hence the Opus price row `('anthropic', 'claude-opus-5')` against GLM's public slugs.
- **The confidential catalog is derived.** `resolveConfidentialManagedModel` (`managed-models.ts:32-44`) filters `defaultModels` for `provider === 'tinfoil' && isConfidential === 1`, plus legacy ids `glm-5-2` and `deepseek-v4-flash` that older clients still send. A new confidential model needs no backend edit but 503s until it has a price row.

## Admission: price first, then quota

Both tiers call `checkManagedInferenceAdmission` (`usage-ledger.ts:157`) before any upstream request. Price and spend load concurrently; price failures win, so a missing price row reports configuration, not quota.

| Outcome             | Status | Body                                                               |
| ------------------- | ------ | ------------------------------------------------------------------ |
| `price-unavailable` | 503    | `{ "error": { "code": "INFERENCE_PRICE_UNAVAILABLE" } }`           |
| `quota-exceeded`    | 429    | `{ "error": { "code": "INFERENCE_QUOTA_EXCEEDED", "window": … } }` |
| `allowed`           | n/a    | request proceeds with the loaded price                             |

Bodies come from [`usage-responses.ts`](../../backend/src/inference/usage-responses.ts) and are stable. This 429 is **not** the request rate limiter, whose body is a flat `{ error: 'Too many requests. Please try again later.' }` ([`rate-limit.ts:81`](../../backend/src/middleware/rate-limit.ts)): body shape alone tells a spend ceiling from a request ceiling. See [rate-limiting.md](../../backend/docs/rate-limiting.md).

### Prices are data, not code

- `inference_prices` ([`inference-usage-schema.ts:9`](../../backend/src/db/inference-usage-schema.ts)) is keyed `(provider, model)`, nano-USD per token as `bigint` with non-negative checks. No fallback, no default: a model with no row is unbuyable.
- Rows come from [`0028_seed-inference-prices.sql`](../../backend/drizzle/0028_seed-inference-prices.sql) and [`0029_seed-glm-5-3-prices.sql`](../../backend/drizzle/0029_seed-glm-5-3-prices.sql).
- **A new managed model needs a price migration** and its `backend/drizzle/meta/_journal.json` entry. Drizzle finds migrations through the journal; an unlisted SQL file never runs.
- Catalog in TypeScript, prices in Postgres, so drift runs one way: the model ships, the price does not, every request 503s.
- Prices are quota weighting, not billing. 0029 sets GLM 5.3 to `1500 / 5250`, glm-5-2's numbers rather than Tinfoil's list `1800 / 5750`, so a model swap does not change how fast users burn their allowance.
- `calculateInferenceCost` (`usage-ledger.ts:78`) applies Anthropic prompt-cache multipliers (5-minute write ×1.25, 1-hour write ×2, cache read ×0.1) only when `provider === 'anthropic'`; the confidential receipt contract has no cache fields ([`shared/inference-usage.ts:9`](../../shared/inference-usage.ts)).
- Cache tokens above the prompt-token total, or a cost above Postgres `bigint` max, throw (`InferenceTokenCountOutOfRangeError` / `InferenceCostOverflowError`).

### The two rolling windows

Defaults, overridden by the `INFERENCE_QUOTA_*` knobs:

| Window | Anonymous session | Registered account |
| ------ | ----------------- | ------------------ |
| 5 h    | 10¢               | 1500¢              |
| 7 d    | 60¢               | 7500¢              |

- `checkInferenceQuota` (`usage-ledger.ts:127`) sums `inference_usage.cost_nano_usd` over both windows in one aggregate using Postgres's own `now()`, keeping windows consistent across replicas.
- Limits are integer cents, split anonymous from registered (`getInferenceQuotaLimits`, `usage-ledger.ts:184`), because anonymous sessions are free to create. Knobs: [configuration.md](../self-hosting/configuration.md#managed-inference-quotas).
- The ledger insert is idempotent on the event id (`onConflictDoNothing`, `usage-ledger.ts:120`), returning `'inserted'` or `'duplicate'`. That makes receipt retries safe.

## Direct tier: `/v1/chat/*`

| Route                              | Shape              | Notes                                                                                                             |
| ---------------------------------- | ------------------ | ----------------------------------------------------------------------------------------------------------------- |
| `POST /v1/chat/completions` (L270) | OpenAI             | streaming only                                                                                                    |
| `POST /v1/chat/v1/messages` (L390) | Anthropic Messages | streaming only; Zod-validated, Anthropic-specific fields passed through as `unknown` for the upstream to validate |

[`backend/src/inference/routes.ts`](../../backend/src/inference/routes.ts) mounts both under `prefix: '/chat'` (L250); `/v1` comes from the app mount in `backend/src/index.ts`. Only slugs in `managedDirectRuntimes` are accepted, today `opus-5`.

- Messages adds request-level `cache_control: { type: 'ephemeral' }` (L462-464); Anthropic moves that breakpoint to the last cacheable block each turn, coexisting with the Pi harness's per-block breakpoints.
- `sanitizeMessageRoles` (L67-69) downgrades `developer` and `system` to `user` on the completions route for every message but the first, blocking a smuggled second system prompt. Messages needs no equivalent: its system prompt is a separate field.
- `createUsageCallbacks` (L163) writes the ledger row in the SSE `onUsage`; `onUsageMissing` / `onUsageError` log upstreams with no usage block.
- Telemetry is body-free: status, model, provider, error kind, token counts, never content (`posthog-privacy.test.ts` pins this).
- **Client routing.** Managed rows with `vendor: 'anthropic'` route to Messages (`src/acp/built-in-adapter.ts:449`) via `resolveManagedAnthropicConnection` ([`src/ai/fetch.ts:328`](../../src/ai/fetch.ts)), shared by the legacy AI-SDK path and the Pi harness so they cannot drift. It deletes the `x-api-key` the Anthropic SDK insists on writing and re-sends the value as `Authorization: Bearer`: the backend authenticates the app session, not an Anthropic key. The `thunderbolt` placeholder for a missing bearer under SSO cookie auth is dropped, not promoted (`fetch.ts:272-284`).
- **No configuration pre-check here.** Without `ANTHROPIC_API_KEY`, admission passes and the client constructor throws (`client.ts:297`) as a 500; the confidential route answers a clean 503.

## Confidential tier: `/v1/tinfoil/*`

[`backend/src/tinfoil/routes.ts`](../../backend/src/tinfoil/routes.ts) is a pass-through, not a client. `{ parse: 'none' }` (L460) keeps the HPKE-sealed request byte-for-byte; `decompress: false` (L312) keeps response bytes opaque for the frontend SDK. `GET`, `POST` and `OPTIONS` only, else 405; a missing `TINFOIL_API_KEY` is 503 `Tinfoil provider not configured`.

- **The header blocklist (L41-53) is a security boundary.** `authorization`, `x-api-key`, `host`, `cookie`, `x-app-version`, `x-app-language`, the device headers and `X-Inference-Model` are dropped before `Authorization: Bearer <TINFOIL_API_KEY>` is injected. The session credential must never reach the enclave, nor the enclave's key the client.
- **`X-Tinfoil-Enclave-Url` is client-supplied and guarded.** Tinfoil's ATC picks the enclave whose HPKE key sealed the body, so the client names it. `resolveEnclaveUrl` (L105) accepts only HTTPS `tinfoil.sh` hosts, else 400. That is the SSRF guard.
- **Upstream CORS headers are stripped (L317-326)**: the enclave emits a duplicated `Access-Control-Allow-Credentials: true, true` that browsers reject. The backend's own `cors()` sets the correct ones.
- **Only chat is metered**: a `POST` whose decoded upstream path is `/v1/chat/completions` (L244-245). Voice rides the same attested route ([`thunderbolt-engine.ts`](../../src/voice/engine/thunderbolt-engine.ts)) over `/audio/transcriptions` and `/audio/speech` ([`audio-engine.ts:110`, `:140`](../../src/voice/engine/audio-engine.ts)), neither quota-checked nor charged. Another metered path means extending that condition, not just the client.
- **The model comes from a header.** The body is sealed, so the client sends `X-Inference-Model` ([`shared/inference-usage.ts:5`](../../shared/inference-usage.ts)). Unrecognized is 400 before the enclave; _absent_ prices as `glm-5-3` (L247-249) for clients predating the header.
- **The prompt-cache secret is not ours to see.** The enclave partitions its cache by a client-generated 32-byte `userCacheSecret` ([`src/lib/auth-token.ts:61`](../../src/lib/auth-token.ts) in the app, `randomBytes(32)` in the CLI), sent to the attested enclave, never the backend.
- **A personal access token is refused by default.** `x-api-key` gets 403 `WEB_LOGIN_REQUIRED` unless `CONFIDENTIAL_API_KEYS_ENABLED=true` ([`web-session.ts:24`](../../backend/src/inference/web-session.ts)); its JSDoc and [pat-lifecycle.md](../../backend/docs/pat-lifecycle.md) explain why this is authorization, not cryptography. Under `CLI_DEVICE_REGISTRATION_ENABLED`, a CLI-device-grant session must also match a live, unrevoked `cli` device row or get 409 `CLI_DEVICE_NOT_BOUND` ([`cli-device.ts`](../../backend/src/inference/cli-device.ts)), on `/v1/chat/*` and the receipt route too.
- **Attestation is slow, so the pool is kept warm.** `createTinfoilKeepWarm` ([`keep-warm.ts`](../../backend/src/tinfoil/keep-warm.ts)) issues `GET /models` every 60 s against the last-used enclave origin, no-ops without `TINFOIL_API_KEY`, and logs failures at debug without affecting availability. Constructed `index.ts:215`, started `:259`, stopped `:274`.

Client-side attestation and caching live in [`src/ai/tinfoil-client.ts`](../../src/ai/tinfoil-client.ts): one cached `SecureClient` per kind (`system` keyed by cloud URL, `user` for BYOK Tinfoil keys), a 15-second bound on the SDK's non-abortable `ready()`, eviction of the failed generation only, and `isTinfoilTransportWedgedError` for failures needing a fresh client.

## Usage receipts

A receipt is the backend telling itself, through the client, what it already decided: issued at admission, returned on the response, posted back with the token counts the client read from the decrypted stream.

**Format** ([`usage-receipt.ts`](../../backend/src/inference/usage-receipt.ts)): `iu1.<base64url claims>.<hmac>`.

- Signed claims: `eventId`, `userId`, `provider`, `model`, both per-token prices, `issuedAt`/`expiresAt`. Two-hour lifetime (L19), 60 s future skew tolerated (L20, L107).
- The HMAC key derives from `BETTER_AUTH_SECRET` under `thunderbolt/inference-usage-receipt/key/v1` (L18, L42-45), so it is not the session key.
- Verification is constant-time and re-validates the claim schema after the signature, including that the model is still a recognized confidential one.
- **Token counts are not signed** and cannot be: only the client can read the enclave's response. The server fixes _who_, _what_ and _at what price_; the client reports _how much_. It can under-report itself, not bill another account (a `userId` mismatch is 403, `usage-receipt-routes.ts:114`) or invent a price.

**Transport.** The `X-Inference-Usage-Receipt` response header, set only on upstream success and stripped from the upstream headers first (`tinfoil/routes.ts:321-328`) so the enclave cannot forge one. It is in `defaultCorsExposeHeaders` (`backend/src/config/settings.ts:11`); browsers expose only listed headers cross-origin, so removing it silently stops all browser-side metering.

**`POST /v1/inference-usage/receipts`** ([`usage-receipt-routes.ts`](../../backend/src/inference/usage-receipt-routes.ts)) parses the body by hand under `parse: 'none'`, 4096-byte cap. All responses are body-free:

| Status | Meaning                                                     |
| ------ | ----------------------------------------------------------- |
| 204    | stored, or a duplicate `eventId` (replays are deduplicated) |
| 400    | malformed, expired, or out-of-range; never becomes valid    |
| 403    | the receipt belongs to another account                      |
| 503    | transient storage failure, retry                            |

### Correlation, shared by the app and the CLI

[`shared/agent-core/confidential-model.ts`](../../shared/agent-core/confidential-model.ts) wraps the Pi provider at the stream seam: captures the header via `onResponse`, stages it against the exact terminal assistant message, and submits only if that message is the harness's last and did not error or abort (L139-149, L266-314). `promptTokens = input + cacheRead + cacheWrite`; a non-safe-integer count drops the submission.

### Delivery differs between the two clients

- **App**: POST via the authenticated `HttpClient`, 3-second timeout, failures logged ([`src/ai/inference-usage-receipt.ts`](../../src/ai/inference-usage-receipt.ts), wired at `src/acp/built-in-adapter.ts:381`). No queue: a crash between completion and POST loses that usage.
- **CLI**: a durable outbox at `$THUNDERBOLT_HOME/inference-usage-receipts/<deviceId>.json` (`~/.thunderbolt/…` by default), written `0600` under a file lock _before_ the first attempt and removed only on acknowledgement ([`cli/src/provider-runtime/usage-receipt.ts`](../../cli/src/provider-runtime/usage-receipt.ts), L100-137; path at [`tinfoil.ts:108`](../../cli/src/provider-runtime/tinfoil.ts)). 3-second timeout per attempt, two retries at 100 ms and 500 ms, flushed at the start of the next confidential run.

Failures are classified rather than blanket-retried (`usage-receipt.ts:161-181`):

| Response  | Disposition                                    |
| --------- | ---------------------------------------------- |
| 429, 5xx  | retry                                          |
| 403       | discard, it can never succeed for this account |
| 401       | retain, and trigger `onStoredSessionRejected`  |
| any other | retain for later                               |

The CLI also refuses a confidential model on a PAT before any binding (`credential.type === 'pat' && model.isConfidential === 1` throws `WEB_LOGIN_REQUIRED`, `cli/src/provider-runtime/runtime.ts:115`, `:634`) and does not fall back. Curl recipe and dispositions for service callers: [pat-lifecycle.md](../../backend/docs/pat-lifecycle.md#reporting-usage-from-a-service-caller).

## Model rows, keys, and the catalog

Managed and bring-your-own-key rows share the synced `models` table, so the distinction must be legible in data and not just in the UI.

| Kind               | Identifying fields                                                                              | Needs a key?                                          |
| ------------------ | ----------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| **System-managed** | `isSystem: 1`, `provider` `thunderbolt` or `tinfoil`; confidential ones add `isConfidential: 1` | no, server-authenticated                              |
| **BYOK**           | `openai`, `anthropic`, `openrouter`, `tinfoil`, `custom`                                        | yes, except `custom` (a local endpoint may need none) |

- `needsApiKey` exempts `thunderbolt` by provider and `tinfoil` only when `isSystem === 1` ([`model-policy.ts:52-60`](../../src/settings/models/model-policy.ts)). Test Connection is narrower, skipped for `thunderbolt` alone (`:39`), the only provider with nothing to verify.
- **Keys are never in the model row.** `SharedModel` ([`shared/defaults/models.ts:18`](../../shared/defaults/models.ts)) omits `apiKey`; keys live in `models_secrets`, a local-only SQLite table that is never synced ([`src/db/tables.ts:144`](../../src/db/tables.ts)), LEFT-JOINed by the DAL at read time ([`src/dal/models.ts:17-25`](../../src/dal/models.ts)). That also makes the public `/v1/config` payload structurally incapable of leaking a key.
- **Key edits are three-valued.** `ApiKeyEdit` is `keep | replace | clear`, mapping to `undefined | value | null` for the DAL (`model-policy.ts:7-15`): `undefined` keeps the stored key, `null` deletes the row. `modelApiKeyForConnection` (`:18`) resolves the key for a catalog refresh or connection test, so a test can validate a key the user typed but has not saved.
- **Catalog discovery is per provider** ([`model-catalog.ts`](../../src/settings/models/model-catalog.ts)): Thunderbolt's derives from the shipped defaults and is never fetched, Tinfoil's loads without a key, OpenAI/OpenRouter/Anthropic need the user's key (`catalogRequiresApiKey`, `providerAutoFetchesCatalog`).

### Changing the defaults

**Bump `defaultModelsVersion`** (`models.ts:175`) on any change, including reordering, or the colocated snapshot test fails. Model profiles ride the models gate rather than carrying their own version. Contract: [AGENTS.md](../../AGENTS.md#reconciled-defaults-and-version-bumps).

Retiring a model is a one-way door. `cleanupRemovedDefaults` soft-deletes every alive `isSystem: 1` row missing from `defaultModels` without checking for local edits (`reconcile-defaults.ts:408-418`), so customizations on a retired default are lost. That is deliberate: historical `hashModel` field-list changes made unmodified rows look edited, stranding retired system models on devices forever. User-created rows are exempt via their null `defaultHash`.

## Self-hosting

| Variable                        | Enables                                                         |
| ------------------------------- | --------------------------------------------------------------- |
| `ANTHROPIC_API_KEY`             | the direct tier (`/v1/chat/*`)                                  |
| `TINFOIL_API_KEY`               | the confidential tier (`/v1/tinfoil/*`) and the keep-warm probe |
| `TINFOIL_ENCLAVE_URL`           | enclave base URL; must include the `/v1` prefix                 |
| `CONFIDENTIAL_API_KEYS_ENABLED` | lets a PAT reach the confidential routes                        |
| `INFERENCE_QUOTA_*`             | the four rolling-window budgets                                 |

Full descriptions: [configuration.md](../self-hosting/configuration.md#ai-provider-keys). With neither key set the three catalog rows still appear (they are client-side defaults) but every managed request fails; the deployment is BYOK-only.

`GET /v1/health/models` (token-gated, `backend/src/api/health.ts:131`) probes every `defaultModels` entry against its real upstream: one non-streaming completion, 20 s per model, three at a time, confidential ones through a freshly attested enclave. Failures report as `not-configured`, `missing-price`, `timeout`, `upstream-error` or `no-text` ([`model-probe.ts`](../../backend/src/inference/model-probe.ts)), so the two silent failure modes above are distinguishable without reading logs.

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
