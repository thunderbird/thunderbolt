# Managed Inference Usage Guardrails Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add costed usage accounting and rolling soft quotas for all managed models, using backend-observed usage for DeepSeek and Opus and signed per-step client receipts for confidential GLM.

**Architecture:** One server-only price table, ledger, and database-clock quota query serve all three models. Direct SSE streams consume provider usage after natural exhaustion; the opaque GLM proxy signs server-owned request context and the official frontend returns cooperative token counts after each completed AI SDK step.

**Tech Stack:** TypeScript, Bun, Elysia, Drizzle ORM, PostgreSQL/PGlite, OpenAI SDK, AI SDK 6.0.190, Tinfoil SecureClient/EHBP, Better Auth secret, `node:crypto`, HMAC-SHA-256.

**Spec:** `docs/superpowers/specs/2026-08-25-managed-inference-usage-guardrails-design.md`

## Global Constraints

- Keep the current Bun version. Do not add `node:https`, trailers, Undici, a helper, a sidecar, a manual HTTP parser, or non-streaming inference.
- Keep the existing SecureClient/EHBP request and response bytes unchanged.
- Canonical models are `tinfoil/deepseek-v4-flash`, `anthropic/claude-opus-5`, and `tinfoil/glm-5-2`.
- Approved baseline nanoUSD rates are `300/700`, `5000/25000`, and `1500/5250`; reverify official sources immediately before seeding, update the seed and independent oracle when exact rates differ, and stop only if an exact canonical SKU price cannot be established.
- Anonymous limits are `10` cents per five hours and `60` cents per seven days. Registered limits are `1500` and `7500` cents.
- Use completed spend only, one database-clock aggregate query, and soft overshoot. Do not add reservations, locks, counters, Redis, pending rows, or schedulers.
- Keep `inference_prices` and `inference_usage` server-only. Do not add PowerSync or frontend schemas.
- Use Drizzle bigint `{ mode: 'bigint' }` for rates and cost, PostgreSQL integer for stored token counts, canonical decimal strings for signed rates, and nonnegative safe integers for incoming token counts.
- Keep parser acceptance at nonnegative safe integers. Enforce PostgreSQL integer maximum `2_147_483_647` only at the ledger insertion boundary.
- GLM token quantities are cooperative and forgeable; identity, model, request-start prices, cost, and quota remain server-owned.
- All accounting failures after a completed chat are caught and body-free. Never log content, opaque bytes, receipt tokens, authorization, complete headers, raw errors, tool arguments, or response bodies.
- Use `apply_patch` for hand edits and `bun db generate` for migration files. Add quota defaults to `backend/.env.example`; inspect deployment configuration before adding explicit overrides.
- Coding workers do not run manual `git add`, `git commit`, or `git push`. The orchestrator uses `/thunderpush` at each checkpoint.
- When parallel diffs share this worktree, no staging, commit, push, or checkpoint occurs while either coding agent or any required reviewer is still running.

---

## File map

- `backend/src/db/inference-usage-schema.ts`: server-only tables, checks, keys, and usage index.
- `backend/src/inference/usage-ledger.ts`: price lookup, cost calculation, insert, and one-query quota decision.
- `backend/src/utils/streaming.ts`: direct stream lifecycle and latest valid usage observation.
- `backend/src/inference/routes.ts`: direct model policy, forced usage request, and ledger consumer.
- `backend/src/inference/usage-receipt.ts`: signed token issuance and verification.
- `backend/src/inference/usage-receipt-routes.ts`: authenticated body-free receipt endpoint.
- `shared/inference-usage.ts`: mandatory receipt header, path, and request-body contract; created and owned once by Task 1 Track A, then read-only for every later task.
- `src/ai/inference-usage-receipt.ts`: system GLM per-step validation and authenticated callback.
- `backend/src/tinfoil/routes.ts`: exact GLM policy check and successful-response header issuance.
- `backend/src/inference/managed-usage.integration.test.ts`: deterministic production-path proof across all models.

### Task 1: Parallel ledger and direct stream foundations

Run Track A and Track B in parallel. They have disjoint files and fixed interfaces below.

#### Track A: Schema, prices, ledger, and quotas

**Files:**

- Create: `backend/src/db/inference-usage-schema.ts`
- Create: `backend/src/inference/usage-ledger.ts`
- Create: `backend/src/inference/usage-ledger.test.ts`
- Create: `shared/inference-usage.ts`
- Generate: schema migration and metadata paths reported by `bun db generate`
- Generate: custom seed path reported by `bun db generate --custom --name=seed-inference-prices`
- Modify: `backend/src/db/schema.ts`
- Modify: `backend/src/config/settings.ts`
- Modify: `backend/src/config/settings.test.ts`
- Modify: `backend/.env.example`
- Modify: `backend/drizzle/meta/_journal.json`

**Interfaces:**

- Consumes: Better Auth `user.id` and `user.isAnonymous`; Drizzle `db`.
- Produces:

```ts
export type ManagedInferenceIdentity = Readonly<{ provider: 'anthropic' | 'tinfoil'; model: string }>
export type InferenceTokenCounts = Readonly<{ promptTokens: number; completionTokens: number; totalTokens: number }>
export type InferencePrice = ManagedInferenceIdentity &
  Readonly<{
    inputNanoUsdPerToken: bigint
    outputNanoUsdPerToken: bigint
  }>
export type InferenceQuotaLimits = Readonly<{ fiveHourCents: number; sevenDayCents: number }>
export type InferenceQuotaDecision =
  | Readonly<{
      allowed: true
      exceededWindow: null
      fiveHourSpentNanoUsd: bigint
      sevenDaySpentNanoUsd: bigint
      limits: InferenceQuotaLimits
    }>
  | Readonly<{
      allowed: false
      exceededWindow: '5h' | '7d'
      fiveHourSpentNanoUsd: bigint
      sevenDaySpentNanoUsd: bigint
      limits: InferenceQuotaLimits
    }>
export type InferenceDatabase = Pick<typeof db, 'execute' | 'insert' | 'select'>
export type RecordInferenceUsageInput = Readonly<{
  id: string
  userId: string
  counts: InferenceTokenCounts
  price: InferencePrice
}>
export const maxPostgresInteger = 2_147_483_647
export class InferenceTokenCountOutOfRangeError extends Error {}
export class InferenceCostOverflowError extends Error {}
export const loadInferencePrice: (
  database: InferenceDatabase,
  identity: ManagedInferenceIdentity,
) => Promise<InferencePrice | null>
export const calculateInferenceCost: (counts: InferenceTokenCounts, price: InferencePrice) => bigint
export const recordInferenceUsage: (
  database: InferenceDatabase,
  input: RecordInferenceUsageInput,
) => Promise<'inserted' | 'duplicate'>
export const checkInferenceQuota: (
  database: InferenceDatabase,
  userId: string,
  limits: InferenceQuotaLimits,
) => Promise<InferenceQuotaDecision>
export const getInferenceQuotaLimits: (settings: Settings, isAnonymous: boolean) => InferenceQuotaLimits
```

Shared wire contract:

```ts
export const inferenceUsageReceiptHeader = 'X-Inference-Usage-Receipt'
export const inferenceUsageReceiptPath = 'inference-usage/receipts'
export type InferenceUsageReceiptRequest = {
  receipt: string
  promptTokens: number
  completionTokens: number
  totalTokens: number
}
```

- [ ] **Step 1A.1: Write failing schema, cost, price, quota, replay, settings, and cascade tests**

```ts
expect(await loadInferencePrice(database, { provider: 'tinfoil', model: 'deepseek-v4-flash' })).toMatchObject({
  inputNanoUsdPerToken: 300n,
  outputNanoUsdPerToken: 700n,
})
expect(calculateInferenceCost({ promptTokens: 10_000, completionTokens: 10_000, totalTokens: 20_000 }, price)).toBe(
  10_000_000n,
)
expect(await recordInferenceUsage(database, usage)).toBe('inserted')
expect(await recordInferenceUsage(database, usage)).toBe('duplicate')
const insertCallsBeforeOutOfRange = insert.mock.calls.length
await expect(recordInferenceUsage(database, usageWithPromptTokens(2_147_483_648))).rejects.toBeInstanceOf(
  InferenceTokenCountOutOfRangeError,
)
expect(insert).toHaveBeenCalledTimes(insertCallsBeforeOutOfRange)
expect(quota.fiveHourSpentNanoUsd).toBe(101_250_000n)
expect(quota.allowed).toBeFalse()
expect(getSettings().inferenceQuotaAnonymousFiveHourCents).toBe(10)
```

Also assert PostgreSQL integer token columns, nonnegative database checks, bigint rate/cost mapping, cost overflow rejection, one SQL aggregate for both windows, exact `>=` boundaries with five-hour precedence, seven-day-only exceedance, positive quota settings, price snapshot behavior, user cascade deletion, anonymous promotion preserving the same user-owned rows, and explicit absence from every PowerSync schema/config.

- [ ] **Step 1A.2: Run RED**

Run: `cd backend && bun test src/inference/usage-ledger.test.ts src/config/settings.test.ts --timeout 5000`

Expected: FAIL because the inference schema, wire contract, settings, and ledger exports do not exist.

- [ ] **Step 1A.3: Add the minimal schema and ledger implementation**

```ts
inputNanoUsdPerToken: bigint('input_nano_usd_per_token', { mode: 'bigint' }).notNull(),
outputNanoUsdPerToken: bigint('output_nano_usd_per_token', { mode: 'bigint' }).notNull(),
promptTokens: integer('prompt_tokens').notNull(),
completionTokens: integer('completion_tokens').notNull(),
totalTokens: integer('total_tokens').notNull(),
costNanoUsd: bigint('cost_nano_usd', { mode: 'bigint' }).notNull(),

export const calculateInferenceCost = (counts: InferenceTokenCounts, price: InferencePrice): bigint => {
  const cost =
    BigInt(counts.promptTokens) * price.inputNanoUsdPerToken +
    BigInt(counts.completionTokens) * price.outputNanoUsdPerToken
  if (cost > 9_223_372_036_854_775_807n) throw new InferenceCostOverflowError()
  return cost
}

export const recordInferenceUsage = async (database: InferenceDatabase, input: RecordInferenceUsageInput) => {
  if (Object.values(input.counts).some((count) => count > maxPostgresInteger)) {
    throw new InferenceTokenCountOutOfRangeError()
  }
  const rows = await database
    .insert(inferenceUsage)
    .values({
      id: input.id,
      userId: input.userId,
      provider: input.price.provider,
      model: input.price.model,
      promptTokens: input.counts.promptTokens,
      completionTokens: input.counts.completionTokens,
      totalTokens: input.counts.totalTokens,
      costNanoUsd: calculateInferenceCost(input.counts, input.price),
    })
    .onConflictDoNothing({ target: inferenceUsage.id })
    .returning({ id: inferenceUsage.id })
  return rows.length === 1 ? 'inserted' : 'duplicate'
}
```

Implement `checkInferenceQuota` with one statement using `sum(cost_nano_usd) filter (where created_at >= now() - interval '5 hours')` and the analogous seven-day filter. Limit cents convert to nanoUSD with `10_000_000n` nanoUSD per cent. Reject when either sum is greater than or equal to its limit and choose `5h` when both qualify.

- [ ] **Step 1A.4: Add positive integer-cent settings and documented defaults**

```ts
inferenceQuotaAnonymousFiveHourCents: z.coerce.number().int().positive().default(10),
inferenceQuotaAnonymousSevenDayCents: z.coerce.number().int().positive().default(60),
inferenceQuotaRegisteredFiveHourCents: z.coerce.number().int().positive().default(1500),
inferenceQuotaRegisteredSevenDayCents: z.coerce.number().int().positive().default(7500),
```

Add exact variables `INFERENCE_QUOTA_ANONYMOUS_5H_CENTS`, `INFERENCE_QUOTA_ANONYMOUS_7D_CENTS`, `INFERENCE_QUOTA_REGISTERED_5H_CENTS`, and `INFERENCE_QUOTA_REGISTERED_7D_CENTS` to parsing, tests, and `backend/.env.example`. Inspect deployment manifests first and change them only when an explicit override is already required.

- [ ] **Step 1A.5: Generate schema and sanctioned seed migrations**

Before running either command, record the current `backend/drizzle` directory and `_journal.json` tail.

Run: `cd backend && bun db generate`

Expected: Drizzle reports the generated schema SQL and metadata. Identify them only by comparing the directory and journal before and after; do not rename or predict the generated number, tag, or snapshot.

Reverify the three exact canonical SKU rate pairs against official provider pages at this moment. Record the actual verification date in the seed comment and integration oracle comment. If rates differ, update both. Stop only if an exact canonical price cannot be established.

Run: `cd backend && bun db generate --custom --name=seed-inference-prices`

Replace only the generated custom-migration marker in the reported SQL file with these statements, using the reverified rates and date:

```sql
-- Official prices verified 2026-08-25.
INSERT INTO "inference_prices" ("provider", "model", "input_nano_usd_per_token", "output_nano_usd_per_token")
VALUES ('tinfoil', 'deepseek-v4-flash', 300, 700);
INSERT INTO "inference_prices" ("provider", "model", "input_nano_usd_per_token", "output_nano_usd_per_token")
VALUES ('anthropic', 'claude-opus-5', 5000, 25000);
INSERT INTO "inference_prices" ("provider", "model", "input_nano_usd_per_token", "output_nano_usd_per_token")
VALUES ('tinfoil', 'glm-5-2', 1500, 5250);
```

Expected: the before/after inspection shows one generated schema migration, its generated metadata, one custom seed, and ordered journal entries. Verify the generated snapshot contains both server-only tables and no PowerSync schema changed.

- [ ] **Step 1A.6: Run GREEN and simplify**

Run: `cd backend && bun test src/inference/usage-ledger.test.ts src/config/settings.test.ts --timeout 5000`

Expected: PASS.

Remove duplicate money conversion, query, and validation helpers. Keep the four ledger functions above, one aggregate query, and one shared wire contract. Run the same command again.

#### Track B: Direct SSE usage observer

**Files:**

- Modify: `backend/src/utils/streaming.ts`
- Modify: `backend/src/utils/streaming.test.ts`

**Interfaces:**

- Consumes: OpenAI `ChatCompletionChunk.usage`.
- Produces:

```ts
export type CompletionUsage = Readonly<{ promptTokens: number; completionTokens: number; totalTokens: number }>
type CreateSSEStreamOptions = {
  onError?: (error: unknown) => void
  onUsage?: (usage: CompletionUsage) => Promise<void>
  onUsageError?: (error: unknown) => void
  onUsageMissing?: () => void
}
const parseCompletionUsage: (usage: ChatCompletionChunk['usage']) => CompletionUsage | null
```

- [ ] **Step 1B.1: Write failing lifecycle tests**

```ts
expect(forwarded).toEqual(originalChunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`))
expect(onUsage).toHaveBeenCalledTimes(1)
expect(onUsage).toHaveBeenCalledWith({ promptTokens: 16, completionTokens: 2, totalTokens: 18 })
expect(doneObservedAfterConsumer).toBeTrue()
```

Cover usage on intermediate and final chunks without `choices: []`, malformed later snapshot preserving an earlier valid value, invalid negative/fractional/unsafe counts, natural EOF without usage, upstream error, provider-chunk enqueue failure before exhaustion, cancel before EOF, late cancel after exhaustion, cancel while the post-EOF consumer is pending, synthetic `[DONE]` enqueue failure after exhaustion still attempting the ledger, consumer rejection isolation, and no duplicate consumer call. Assert caller chunks remain byte-equivalent after serialization, no shared chunk or usage object is retained or mutated, and total mismatch is accepted.

- [ ] **Step 1B.2: Run RED**

Run: `cd backend && bun test src/utils/streaming.test.ts --timeout 5000`

Expected: FAIL because lifecycle callbacks and validated latest-snapshot behavior are absent.

- [ ] **Step 1B.3: Implement the minimal observer**

```ts
for await (const chunk of completion) {
  if (isCancelled) break
  const usage = parseCompletionUsage(chunk.usage)
  if (usage) latestUsage = usage
  controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`))
}
naturallyExhausted = !isCancelled
if (naturallyExhausted && latestUsage && options.onUsage) {
  try {
    await options.onUsage(latestUsage)
  } catch (error) {
    options.onUsageError?.(error)
  }
} else if (naturallyExhausted && !latestUsage) {
  options.onUsageMissing?.()
}
if (!isCancelled) controller.enqueue(encoder.encode('data: [DONE]\n\n'))
```

Cancellation aborts the upstream controller only before natural exhaustion. Replace the raw streaming error log with callback-driven body-free reporting.

- [ ] **Step 1B.4: Run GREEN and simplify**

Run: `cd backend && bun test src/utils/streaming.test.ts --timeout 5000`

Expected: PASS.

Keep one usage parser and one terminal path. Remove counters or state not required by the lifecycle rules, then rerun the focused test.

#### Combined Task 1 gate

- [ ] **Step 1C.1: Wait for both tracks and verify the combined foundation**

Do not stage, commit, or push while either Track A or Track B agent is running. After both finish, run: `cd backend && bun test src/inference/usage-ledger.test.ts src/config/settings.test.ts src/utils/streaming.test.ts --timeout 5000`

Expected: PASS. Simplify the combined seams, remove duplicate count/usage types where the shared contract applies, and rerun the command.

- [ ] **Step 1C.2: Pass combined spec and quality review, then checkpoint once**

Run a fresh spec-compliance review against Task 1 requirements and a quality review against `AGENTS.md`. Do not stage or commit while either reviewer is running. Resolve confirmed findings with focused tests and rerun Step 1C.1. Only after both reviews pass, the orchestrator uses `/thunderpush` once with atomic message `feat: add managed inference usage foundations`.

### Task 2: Direct route policy and ledger integration

**Files:**

- Create: `backend/src/inference/usage-responses.ts`
- Modify: `backend/src/inference/client.ts`
- Modify: `backend/src/inference/routes.ts`
- Modify: `backend/src/inference/routes.test.ts`
- Modify: `backend/src/inference/posthog-privacy.test.ts`
- Modify: `backend/src/index.ts`

**Interfaces:**

- Consumes: Task 1 `loadInferencePrice`, `checkInferenceQuota`, `getInferenceQuotaLimits`, `recordInferenceUsage`, and `CompletionUsage` callback.
- Produces: `supportedModels` entries with canonical `provider`, canonical `internalName`, and `supportsStreamUsage: true`; direct routes enforce policy before `getClient` or upstream.

```ts
export const createPriceUnavailableResponse = (): Response =>
  Response.json({ error: { code: 'INFERENCE_PRICE_UNAVAILABLE' } }, { status: 503 })
export const createQuotaExceededResponse = (decision: InferenceQuotaDecision): Response =>
  Response.json({ error: { code: 'INFERENCE_QUOTA_EXCEEDED', window: decision.exceededWindow } }, { status: 429 })

export type InferenceUsageLog =
  | { event: 'inference_usage_missing'; provider: InferenceProvider; model: string; route: string }
  | {
      event: 'inference_usage_completed'
      provider: InferenceProvider
      model: string
      eventId: string
      transport: 'direct' | 'receipt'
    }
  | {
      event: 'inference_usage_inserted'
      provider: InferenceProvider
      model: string
      eventId: string
      outcome: 'inserted' | 'duplicate'
    }
  | { event: 'inference_usage_callback_failed'; provider: InferenceProvider; model: string; route: string }
  | { event: 'inference_usage_receipt_issued'; provider: 'tinfoil'; model: 'glm-5-2'; eventId: string; route: string }

type InferenceLogContext = InferenceUpstreamAttemptLog | InferenceProxyLatencyLog | InferenceUsageLog
export type InferenceLogger = { info: (context: InferenceLogContext, message: string) => void }
```

- [ ] **Step 2.1: Write failing direct route tests**

```ts
expect(upstreamBody.stream_options).toEqual({ include_usage: true })
expect(response.status).toBe(429)
expect(await response.json()).toEqual({ error: { code: 'INFERENCE_QUOTA_EXCEEDED', window: '5h' } })
expect(upstreamFetch).not.toHaveBeenCalled()
expect(insertedUsage).toMatchObject({ provider: 'anthropic', model: 'claude-opus-5', costNanoUsd: 50_000_000n })
```

Cover minimal missing-price `503`, exact threshold rejection, both quota windows with `5h` precedence, canonical identity despite client input, natural completion, invalid/missing usage, stream error, early and late cancellation, consumer database failure, a safe-integer usage count of `2_147_483_648` being rejected by the ledger while the direct stream still completes without a row, PostHog enabled and disabled, usage preservation, `posthogDistinctId`, deterministic raw SSE through the real OpenAI parser, retry-success producing one event without invented failed-attempt usage, and rejection of raw error/cause logging.

- [ ] **Step 2.2: Run RED**

Run: `cd backend && bun test src/inference/routes.test.ts src/inference/posthog-privacy.test.ts --timeout 5000`

Expected: FAIL because direct routes do not load prices, check spend, force usage, or consume ledger usage.

- [ ] **Step 2.3: Implement minimal direct policy**

```ts
type ModelConfig = {
  provider: 'anthropic' | 'tinfoil'
  internalName: string
  supportsStreamUsage: true
  omitTemperature?: boolean
}

const price = await loadInferencePrice(database, { provider, model: internalName })
if (!price) return createPriceUnavailableResponse()
const limits = getInferenceQuotaLimits(settings, ctx.user.isAnonymous === true)
const quota = await checkInferenceQuota(database, ctx.user.id, limits)
if (!quota.allowed) return createQuotaExceededResponse(quota)
```

When `supportsStreamUsage` is true, force `stream_options: { include_usage: true }`. This explicit provider capability prevents a future model from silently inheriting unsupported usage behavior, so it is not fake configurability. Pass `posthogDistinctId: ctx.user.id` and `crypto.randomUUID()` into the post-EOF consumer. Await `recordInferenceUsage` through the Task 1 observer. Mount the database through `createInferenceRoutes` in `backend/src/index.ts`.

- [ ] **Step 2.4: Replace body-bearing route logs**

```ts
logger?.info({ event: 'inference_usage_missing', provider, model: internalName, route }, 'Inference usage missing')
logger?.info(
  { event: 'inference_usage_callback_failed', provider, model: internalName, route },
  'Inference usage callback failed',
)
```

Remove logging of raw error causes, prompt/response content, and raw bodies from the touched direct inference path.

- [ ] **Step 2.5: Run GREEN and simplify**

Run: `cd backend && bun test src/inference/routes.test.ts src/inference/posthog-privacy.test.ts src/utils/streaming.test.ts --timeout 5000`

Expected: PASS.

Keep policy before client construction, a single canonical model lookup, and one consumer. Remove route-local copies of ledger or quota arithmetic, then rerun.

- [ ] **Step 2.6: Orchestrator checkpoint**

Use `/thunderpush` with atomic message `feat: enforce direct inference usage limits`.

### Task 3: Parallel signed receipt endpoint and frontend callback

Start both tracks only after Task 2 fixes canonical identities. Task 1 Track A already owns `shared/inference-usage.ts`; both Task 3 tracks import it read-only and never recreate or modify it. Track A and Track B remain file-disjoint.

#### Track A: Token and authenticated backend endpoint

**Files:**

- Create: `backend/src/inference/usage-receipt.ts`
- Create: `backend/src/inference/usage-receipt.test.ts`
- Create: `backend/src/inference/usage-receipt-routes.ts`
- Create: `backend/src/inference/usage-receipt-routes.test.ts`
- Read only: `shared/inference-usage.ts`

**Interfaces:**

- Consumes: Task 1 read-only `InferenceUsageReceiptRequest`, `InferencePrice`, and `recordInferenceUsage`; Task 2 `InferenceLogger`.
- Produces:

```ts
export type InferenceUsageReceiptClaims = Readonly<{
  purpose: 'inference-usage-receipt'
  version: 1
  eventId: string
  userId: string
  provider: 'tinfoil'
  model: 'glm-5-2'
  inputNanoUsdPerToken: string
  outputNanoUsdPerToken: string
  issuedAt: number
  expiresAt: number
}>
export type IssueReceiptInput = Readonly<{
  eventId: string
  userId: string
  price: InferencePrice & { provider: 'tinfoil'; model: 'glm-5-2' }
  secret: string
  nowSeconds: number
}>
export type ReceiptRouteOptions = Readonly<{
  auth: Auth
  database: InferenceDatabase
  secret: string
  nowSeconds?: () => number
  logger?: InferenceLogger
}>
export const issueInferenceUsageReceipt: (input: IssueReceiptInput) => string
export const verifyInferenceUsageReceipt: (
  token: string,
  secret: string,
  nowSeconds: number,
) => InferenceUsageReceiptClaims | null
export const createInferenceUsageReceiptRoutes: (options: ReceiptRouteOptions) => AnyElysia
```

- [ ] **Step 3A.1: Write failing token contract tests**

```ts
const price: InferencePrice & { provider: 'tinfoil'; model: 'glm-5-2' } = {
  provider: 'tinfoil',
  model: 'glm-5-2',
  inputNanoUsdPerToken: 1_500n,
  outputNanoUsdPerToken: 5_250n,
}
const token = issueInferenceUsageReceipt({
  eventId: 'e8c39457-8831-4c10-86ae-8623b6ce2750',
  userId: 'user-id',
  price,
  secret: 'test-secret',
  nowSeconds: 1_787_616_000,
})
const tampered = `${token.slice(0, -1)}${token.endsWith('A') ? 'B' : 'A'}`
const verified = verifyInferenceUsageReceipt(token, 'test-secret', 1_787_616_000)
expect(verified).toMatchObject({ provider: 'tinfoil', model: 'glm-5-2' })
expect(verifyInferenceUsageReceipt(tampered, 'test-secret', 1_787_616_000)).toBeNull()
```

Cover exactly three segments, base64url charset, decode failures, altered raw payload/signature, wrong purpose/version, canonical UUID, missing/wrong provider, missing/wrong model, decimal rates, exact two-hour expiry, expiry boundary, 60-second future skew, excessive future skew, domain separation from a raw Better Auth HMAC, and equivalent valid JSON key orders. Do not assert a golden token string or reserialization identity.

- [ ] **Step 3A.2: Run token RED**

Run: `cd backend && bun test src/inference/usage-receipt.test.ts --timeout 5000`

Expected: FAIL because issuance and verification do not exist.

- [ ] **Step 3A.3: Implement minimal signing and verification**

```ts
const receiptKey = createHmac('sha256', secret).update('thunderbolt/inference-usage-receipt/key/v1', 'utf8').digest()
const signingInput = `iu1.${payloadSegment}`
const signature = createHmac('sha256', receiptKey).update(signingInput, 'ascii').digest()
```

Require exactly three base64url-character segments and decode them. Derive the domain-separated key, recompute the HMAC over the exact received `iu1.${payloadSegment}`, and use `timingSafeEqual` before parsing or trusting claims. Then strictly validate purpose, version, canonical UUID event ID, `provider === 'tinfoil'`, `model === 'glm-5-2'`, decimal rates, lifetime `7200` seconds, and future skew `60` seconds. Return validated claims on success and `null` for every invalid case. Keep focused tests for each internal validation branch, but do not expose failure reasons to the route. Do not require key order or reserialization equality.

- [ ] **Step 3A.4: Write failing endpoint tests**

```ts
expect(inserted.status).toBe(204)
expect(await inserted.text()).toBe('')
expect(duplicate.status).toBe(204)
expect(wrongUser.status).toBe(403)
expect(expired.status).toBe(400)
expect(databaseFailure.status).toBe(503)
```

Cover authentication, malformed token/body, all safe-integer parser boundaries, total mismatch accepted, a submitted body count of `2_147_483_648` alongside a valid signed receipt mapping the ledger input error to body-free `400`, cost overflow, signed price snapshot after current price change, canonical provider/model enforcement, sequential and concurrent replay, and privacy-safe telemetry.

- [ ] **Step 3A.5: Run endpoint RED**

Run: `cd backend && bun test src/inference/usage-receipt-routes.test.ts --timeout 5000`

Expected: FAIL because the authenticated endpoint does not exist.

- [ ] **Step 3A.6: Implement minimal body-free endpoint**

```ts
const claims = verifyInferenceUsageReceipt(body.receipt, secret, nowSeconds())
if (!claims) return status(400)
if (claims.userId !== user.id) return status(403)
const counts = {
  promptTokens: body.promptTokens,
  completionTokens: body.completionTokens,
  totalTokens: body.totalTokens,
}
const signedPrice = {
  provider: claims.provider,
  model: claims.model,
  inputNanoUsdPerToken: BigInt(claims.inputNanoUsdPerToken),
  outputNanoUsdPerToken: BigInt(claims.outputNanoUsdPerToken),
}
try {
  const outcome = await recordInferenceUsage(database, {
    id: claims.eventId,
    userId: user.id,
    counts,
    price: signedPrice,
  })
  logger?.info(
    { event: 'inference_usage_inserted', provider: 'tinfoil', model: 'glm-5-2', eventId: claims.eventId, outcome },
    'Inference usage receipt stored',
  )
  return status(204)
} catch (error) {
  if (error instanceof InferenceTokenCountOutOfRangeError || error instanceof InferenceCostOverflowError) {
    return status(400)
  }
  return status(503)
}
```

Do not query current prices. Return no response body for every endpoint outcome.

- [ ] **Step 3A.7: Run GREEN and simplify**

Run: `cd backend && bun test src/inference/usage-receipt.test.ts src/inference/usage-receipt-routes.test.ts src/inference/usage-ledger.test.ts --timeout 5000`

Expected: PASS.

Keep one payload encoder, one raw-segment signature verifier, and one endpoint insert path. Remove generalized token abstractions, then rerun.

#### Track B: System GLM per-step callback

**Files:**

- Create: `src/ai/inference-usage-receipt.ts`
- Create: `src/ai/inference-usage-receipt.test.ts`
- Modify: `src/ai/fetch.ts`
- Modify: `src/ai/fetch.test.ts`
- Read only: `shared/inference-usage.ts`

**Interfaces:**

- Consumes: Task 1 shared header, path, and `InferenceUsageReceiptRequest`; existing authenticated `httpClient` passed into `aiFetchStreamingResponse`.
- Produces:

```ts
export type ReceiptStep = Readonly<{
  response: { headers?: Record<string, string | undefined> }
  usage: { inputTokens?: number; outputTokens?: number; totalTokens?: number }
}>
export const submitGlmStepUsageReceipt: (input: {
  model: Pick<Model, 'provider' | 'model' | 'isSystem'>
  step: ReceiptStep
  httpClient: Pick<HttpClient, 'post'>
}) => Promise<'submitted' | 'skipped'>
```

- [ ] **Step 3B.1: Write failing provider and callback tests**

```ts
expect(encryptedRequestBody.stream_options).toEqual({ include_usage: true })
expect(post).toHaveBeenCalledWith('inference-usage/receipts', {
  json: {
    receipt: 'iu1.canonicalPayload.canonicalSignature',
    promptTokens: 16,
    completionTokens: 2,
    totalTokens: 18,
  },
})
expect(callbackSettledBeforeNextStep).toBeTrue()
```

Cover lower-case per-step header, latest aggregate usage, four usage objects, multi-tool steps with one receipt each, awaited callback, missing header/usage, invalid counts, interrupted stream, callback rejection isolation, user-added GLM, and every non-GLM model.

- [ ] **Step 3B.2: Run RED**

Run: `bun test src/ai/inference-usage-receipt.test.ts src/ai/fetch.test.ts --timeout 5000`

Expected: FAIL because system Tinfoil does not request usage and `onStepFinish` does not submit receipts.

- [ ] **Step 3B.3: Implement minimal system provider and callback**

```ts
const tinfoil = createOpenAICompatible({
  name: 'tinfoil',
  baseURL: client.getBaseURL()!,
  apiKey: 'thunderbolt-managed',
  fetch: wrappedFetch,
  includeUsage: true,
})

onStepFinish: async (step) => {
  telemetry?.recordStep()
  try {
    await submitGlmStepUsageReceipt({ model, step, httpClient })
  } catch {
    console.warn('inference_usage_callback_failed', { provider: model.provider, model: model.model })
  }
}
```

The helper validates exact system `tinfoil/glm-5-2`, reads `x-inference-usage-receipt`, maps `inputTokens/outputTokens/totalTokens`, accepts total mismatch, and awaits `httpClient.post`. The explicit `onStepFinish` catch keeps chat running. This is not fire-and-forget: the receipt ledger attempt settles before AI SDK starts the next automatic tool/model step. Do not decode the token or use `onFinish.totalUsage`.

- [ ] **Step 3B.4: Remove content-bearing frontend inference logs**

```ts
console.info('inference_usage_receipt_completed', { provider: model.provider, model: model.model })
console.warn('inference_usage_callback_failed', { provider: model.provider, model: model.model })
```

Emit `inference_usage_missing` when the exact GLM step lacks a valid header or usage. Remove step text, finish text, tool arguments, total prompt content, raw callback error, and response body logging from the touched callbacks.

- [ ] **Step 3B.5: Run GREEN and simplify**

Run: `bun test src/ai/inference-usage-receipt.test.ts src/ai/fetch.test.ts --timeout 5000`

Expected: PASS.

Keep one exact GLM predicate and one validation/post helper. Remove general provider callback plumbing, then rerun.

#### Combined Task 3 gate

- [ ] **Step 3C.1: Wait for both tracks and verify the complete receipt flow**

Do not stage, commit, or push while either Track A or Track B agent is running. After both finish, run backend and frontend focused suites independently:

Run: `cd backend && bun test src/inference/usage-receipt.test.ts src/inference/usage-receipt-routes.test.ts src/inference/usage-ledger.test.ts --timeout 5000`

Run from repository root: `bun test src/ai/inference-usage-receipt.test.ts src/ai/fetch.test.ts --timeout 5000`

Expected: both PASS. Simplify only shared receipt seams and rerun both commands.

- [ ] **Step 3C.2: Pass combined spec and quality review, then checkpoint once**

Run fresh spec-compliance and quality reviews over both tracks together. Do not stage or commit while either reviewer is running. Resolve confirmed findings with focused tests and rerun Step 3C.1. Only after both reviews pass, the orchestrator uses `/thunderpush` once with atomic message `feat: add signed GLM usage receipts`.

### Task 4: GLM proxy issuance, receipt mount, CORS, and shared quotas

**Files:**

- Modify: `backend/src/tinfoil/routes.ts`
- Modify: `backend/src/tinfoil/routes.test.ts`
- Modify: `backend/src/index.ts`
- Modify: `backend/src/types.ts`
- Modify: `backend/src/config/settings.ts`
- Modify: `backend/src/config/settings.test.ts`
- Modify: `src/ai/tinfoil-client.test.ts`
- Read only: `shared/inference-usage.ts`

**Interfaces:**

- Consumes: Task 1 policy/ledger and read-only shared header contract; Task 2 `InferenceLogger`; Task 3 `issueInferenceUsageReceipt` and `createInferenceUsageReceiptRoutes`.
- Produces: exact managed GLM proxy response header and mounted `POST /v1/inference-usage/receipts`.

- [ ] **Step 4.1: Write failing route-selection and opaque-byte tests**

```ts
expect(ok.headers.get('x-inference-usage-receipt')).toMatch(/^iu1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/)
expect(nearMiss.headers.get('x-inference-usage-receipt')).toBeNull()
expect(error.headers.get('x-inference-usage-receipt')).toBeNull()
expect(upstreamRequestBytes).toEqual(originalEncryptedBytes)
expect(downstreamResponseBytes).toEqual(originalEncryptedResponseBytes)
```

Cover exact POST resolved pathname, query preservation, method/path near misses, unauthenticated request, minimal missing-price response, exact quota threshold, both quotas with `5h` precedence before fetch, every non-2xx response, SecureClient header preservation, and CORS exposure.

- [ ] **Step 4.2: Run RED**

Run backend RED: `cd backend && bun test src/tinfoil/routes.test.ts src/config/settings.test.ts --timeout 5000`

Expected: FAIL because the backend proxy neither applies canonical GLM policy nor issues an exposed receipt.

Run the frontend characterization/regression gate independently from the repository root: `bun test src/ai/tinfoil-client.test.ts --timeout 5000`

Expected: PASS, preserving the existing SecureClient header contract characterization. Task 4 does not modify production SecureClient code. Run this command even when the independent backend RED command fails.

- [ ] **Step 4.3: Implement exact pre-upstream GLM policy**

```ts
const isManagedGlmChat = method === 'POST' && new URL(upstreamUrl).pathname === '/v1/chat/completions'
if (isManagedGlmChat) {
  const price = await loadInferencePrice(database, { provider: 'tinfoil', model: 'glm-5-2' })
  if (!price) return createPriceUnavailableResponse()
  const quota = await checkInferenceQuota(database, distinctId, getInferenceQuotaLimits(settings, isAnonymous))
  if (!quota.allowed) return createQuotaExceededResponse(quota)
  const eventId = crypto.randomUUID()
  receipt = issueInferenceUsageReceipt({
    eventId,
    userId: distinctId,
    price: { ...price, provider: 'tinfoil', model: 'glm-5-2' },
    secret,
    nowSeconds: Math.floor(Date.now() / 1000),
  })
  usageLogger?.info(
    { event: 'inference_usage_receipt_issued', provider: 'tinfoil', model: 'glm-5-2', eventId, route },
    'Inference usage receipt issued',
  )
}
```

Pass authenticated `isAnonymous` into the proxy helper. Add the receipt header only after `upstream.ok`, leaving opaque streams untouched. Preserve the existing Tinfoil latency logger and add a separately typed `usageLogger?: InferenceLogger` option for usage events; `backend/src/index.ts` passes `appLogger` to both. Log issued and missing outcomes without token, body, or raw error.

- [ ] **Step 4.4: Mount endpoint and expose header**

Add `X-Inference-Usage-Receipt` to `defaultCorsExposeHeaders`. Mount `createInferenceUsageReceiptRoutes({ auth, database, secret: settings.betterAuthSecret, logger: appLogger })` in `backend/src/index.ts`. Inject the same database into `createTinfoilRoutes` and its tests.

- [ ] **Step 4.5: Run GREEN and simplify**

Run: `cd backend && bun test src/tinfoil/routes.test.ts src/inference/usage-receipt-routes.test.ts src/config/settings.test.ts --timeout 5000 && cd .. && bun test src/ai/tinfoil-client.test.ts src/ai/inference-usage-receipt.test.ts --timeout 5000`

Expected: PASS.

Keep one exact path predicate and one policy branch before fetch. Do not add a second proxy route or preflight flow. Rerun the focused tests.

- [ ] **Step 4.6: Orchestrator checkpoint**

Use `/thunderpush` with atomic message `feat: guard managed GLM inference usage`.

### Task 5: Deterministic cross-model integration

Tasks 1 through 4 already provide focused RED/GREEN cycles for every production behavior. This task adds post-implementation integration verification across the real seams; it does not assume a new production failure.

**Files:**

- Create: `backend/src/inference/managed-usage.integration.test.ts`
- Read only: `shared/inference-usage.ts`

**Interfaces:**

- Consumes: production direct routes, Tinfoil route issuance, receipt endpoint, ledger, migrations, auth, and PGlite.
- Produces: one deterministic proof that completed spend from all transports feeds the same quota.

- [ ] **Step 5.1: Write the production-path integration fixture**

```ts
// Official canonical SKU prices verified 2026-08-25.
const officialFixtureRates = {
  deepseek: { input: 300n, output: 700n },
  opus: { input: 5_000n, output: 25_000n },
  glm: { input: 1_500n, output: 5_250n },
} as const

expect(deepseekRow.costNanoUsd).toBe(10_000_000n) // 10,000 input and 10,000 output
expect(opusRow.costNanoUsd).toBe(50_000_000n) // 5,000 input and 1,000 output
expect(glmRow.costNanoUsd).toBe(41_250_000n) // 10,000 input and 5,000 output
expect(total).toBe(101_250_000n)
expect(fourth.status).toBe(429)
expect(providerCalls).toBe(3)
```

Use independent literals, not production price constants. If reverified rates differ, update this dated oracle and choose fixture token counts that retain explicit expected-cost arithmetic. For GLM, call the real proxy route, read its signed response header, then call the real receipt endpoint and query the production ledger. Do not use a trailer transport or usage-consumer spy.

- [ ] **Step 5.2: Run the integration verification**

Run: `cd backend && bun test src/inference/managed-usage.integration.test.ts --timeout 5000`

Expected: PASS when Tasks 1 through 4 are correctly wired. If it passes initially, record that no production correction was needed. If it fails because of a production gap, preserve that failing integration case as RED before changing production code.

- [ ] **Step 5.3: Resolve only demonstrated gaps**

The fixture creates an anonymous authenticated user in migrated PGlite, seeds the independent prices, streams DeepSeek and Opus usage through real direct routes, issues and redeems the GLM receipt, and attempts a fourth managed request. Do not add production hooks for the test. If Step 5.2 is already green, make no production change. If it exposed a real gap, add the narrowest focused test beside the owning production module, apply the minimal correction, run that focused test, then rerun the integration test to GREEN.

- [ ] **Step 5.4: Repeat integration verification and simplify the harness**

Run: `cd backend && bun test src/inference/managed-usage.integration.test.ts --timeout 5000 --rerun-each 5`

Expected: five PASS runs with three rows, exact total `101250000`, and fourth request rejected before provider invocation.

Remove duplicated setup that does not clarify transport boundaries. Keep the independent price literals and real route calls, then rerun five times.

- [ ] **Step 5.5: Orchestrator checkpoint**

Use `/thunderpush` with atomic message `test: prove managed inference guardrails end to end`.

### Task 6: Adversarial review, full verification, live validation, and publication

**Files:**

- Review: every file changed in Tasks 1 through 5
- Modify only when a review finding is confirmed by a failing test

**Interfaces:**

- Consumes: complete implementation and acceptance criteria.
- Produces: reviewed, fully verified branch and an assigned draft pull request.

- [ ] **Step 6.1: Run three fresh adversarial reviews**

Run the following independently against the complete diff:

```bash
claude --model fable -p "Review the current diff adversarially for authentication, signature verification order, replay races, integer and bigint overflow, quota bypass, cancellation timing, and privacy. Report only concrete findings with file and line evidence."
claude --model fable -p "Review the current diff for unnecessary complexity, duplicate policy, weak test seams, transport mutation, and requirements drift. Report the smallest corrective changes with file and line evidence."
```

Also dispatch a fresh `gpt-5.6-sol` reviewer at `xhigh` effort to review standards, spec compliance, and privacy against the complete diff. Expected: three evidence-based reports. For each confirmed finding, first add a focused failing Bun test, then apply the smallest fix, rerun that test, and perform a simplification sweep. Reject findings that cannot be reproduced or tied to the spec.

- [ ] **Step 6.2: Run focused and full automated verification**

```bash
(cd backend && bun test src/inference/usage-ledger.test.ts src/utils/streaming.test.ts src/inference/routes.test.ts src/inference/usage-receipt.test.ts src/inference/usage-receipt-routes.test.ts src/tinfoil/routes.test.ts src/inference/managed-usage.integration.test.ts --timeout 5000)
(cd backend && bun run type-check)
(cd backend && bun run lint)
(cd backend && bun run build)
bun run test:backend
bun run test
bun run check
bun run build
(cd backend && bun test src/inference/managed-usage.integration.test.ts --timeout 5000 --rerun-each 5)
```

Run the block from the repository root. Backend commands execute in subshells, so no directory change affects a later root command. Expected: every command exits zero and the integration fixture passes five times.

- [ ] **Step 6.3: Validate live providers without mutating environment files**

Prerequisites are an isolated approved development or staging backend/database/user; session-only `TINFOIL_ORG_ADMIN_KEY` plus `TINFOIL_API_KEY` created with nonsecret name `thunderbolt-managed-usage-validation`; and session-only `ANTHROPIC_ADMIN_API_KEY` plus `ANTHROPIC_API_KEY` created with the same dedicated name and used only by this validation. Report only credential presence and approved target classification. Do not print raw environment values, URLs from environment, hostnames, credentials, key IDs/values, tokens, or connection strings. Use shell-scoped overrides only, never edit environment files, and restore the shell after validation.

Quiesce both dedicated inference keys before measurement and allow no concurrent use. Take a baseline, send exactly one short completed request for each canonical model in this order, and reconcile it before moving to the next: `tinfoil/deepseek-v4-flash`, `anthropic/claude-opus-5`, then `tinfoil/glm-5-2`. DeepSeek and Opus use real authenticated backend streams through natural `[DONE]`; GLM uses the real SecureClient path, browser-visible receipt header, awaited body-free `204`, and production ledger row.

For each Tinfoil model, call `GET https://api.tinfoil.sh/api/billing/usage?time=5m` with `Authorization: Bearer` populated from `TINFOIL_ORG_ADMIN_KEY`; perform at most 20 post-request polls, 15 seconds apart. Isolate the delta by dedicated API-key name and canonical model. For Opus, call `GET https://api.anthropic.com/v1/organizations/usage_report/messages` with `x-api-key` populated from `ANTHROPIC_ADMIN_API_KEY` and `anthropic-version: 2023-06-01`; bound the query with request-adjacent `starting_at`/`ending_at`, `bucket_width=1m`, and grouping by API key ID and model. Perform at most 20 post-request polls, 30 seconds apart, and select only the dedicated inference key plus `claude-opus-5`. Compare provider input/output deltas to the single corresponding database row and recalculate `costNanoUsd` from the verified rate.

Record one sanitized evidence row per model with exactly these columns: `provider`, `canonicalModel`, `dedicatedKeyName`, `requestStartedAtUtc`, `requestFinishedAtUtc`, `providerWindowUtc`, `pollAttempts`, `providerInputTokens`, `providerOutputTokens`, `ledgerPromptTokens`, `ledgerCompletionTokens`, `ledgerTotalTokens`, `ledgerCostNanoUsd`, `result`. Do not include prompts, responses, raw headers, receipt tokens, credential material, hostnames, or connection strings.

Missing admin credentials, any concurrent-use contamination, an ambiguous key/model match, or polling timeout is a precise human blocker and never a false PASS. After all three reconciliations pass, smoke the actual frontend and backend with one short completed conversation on each managed model. Confirm streaming, tool-step progression, quota error copy, and absence of content or receipt tokens in logs. Then abort a separate GLM stream and confirm no row appears without a receipt.

- [ ] **Step 6.4: Final simplification and privacy audit**

Search changed files for duplicate money conversion, a second quota query, unsigned identity or price input, raw `fetch` for the callback, content-bearing logs, PowerSync schema additions, trailer logic, pending rows, and new alert infrastructure. Remove only confirmed scope creep and rerun Step 6.2.

- [ ] **Step 6.5: Orchestrator checkpoint and publication**

If review fixes changed code, use `/thunderpush` with atomic message `chore: address managed inference review findings`. Confirm every local, full, live, and review gate above passed, the branch is clean, and all commits are pushed. Only then use the repository pull-request workflow to create an assigned draft titled `feat: add managed inference usage guardrails` with Summary, Test Plan, Changes, official price-source evidence, repeated-test evidence, and live-validation evidence.

After the draft exists, observe its PR checks and verify both CI and Title Lint. Do not claim PR-only CI success before PR creation. If a check fails, preserve the failure evidence, apply the smallest tested correction, rerun the affected local/full gate, push through `/thunderpush`, and observe the PR checks again.
