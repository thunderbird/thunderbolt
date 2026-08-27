/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { user } from '@/db/auth-schema'
import { inferencePrices, inferenceUsage } from '@/db/inference-usage-schema'
import { createTestDb } from '@/test-utils/db'
import { and, eq, sql } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { resolve } from 'path'
import {
  calculateInferenceCost,
  checkManagedInferenceAdmission,
  checkInferenceQuota,
  getInferenceQuotaLimits,
  InferenceCostOverflowError,
  InferenceTokenCountOutOfRangeError,
  loadInferencePrice,
  maxPostgresInteger,
  recordInferenceUsage,
  type InferenceDatabase,
  type InferencePrice,
  type InferenceTokenCounts,
  type RecordInferenceUsageInput,
} from './usage-ledger'

type TestDatabase = Awaited<ReturnType<typeof createTestDb>>['db']

const postgresBigintMax = 9_223_372_036_854_775_807n
const oneCentNanoUsd = 10_000_000n
const deepseekIdentity = { provider: 'tinfoil', model: 'deepseek-v4-flash' } as const
const opusIdentity = { provider: 'anthropic', model: 'claude-opus-5' } as const
const glmIdentity = { provider: 'tinfoil', model: 'glm-5-2' } as const

const insertUser = async (database: TestDatabase, id: string, isAnonymous = false) => {
  await database.insert(user).values({
    id,
    name: isAnonymous ? 'Anonymous User' : 'Registered User',
    email: `${id}@example.com`,
    emailVerified: !isAnonymous,
    isAnonymous,
  })
}

const loadRequiredPrice = async (
  database: TestDatabase,
  identity: typeof deepseekIdentity | typeof opusIdentity | typeof glmIdentity,
) => {
  const price = await loadInferencePrice(database, identity)
  expect(price).not.toBeNull()
  return price!
}

const usageInput = (
  id: string,
  userId: string,
  price: InferencePrice,
  counts: InferenceTokenCounts = { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
): RecordInferenceUsageInput => ({ id, userId, price, counts })

describe('inference usage ledger', () => {
  let database: TestDatabase
  let client: Awaited<ReturnType<typeof createTestDb>>['client']
  let cleanup: () => Promise<void>

  beforeEach(async () => {
    const testDb = await createTestDb()
    database = testDb.db
    client = testDb.client
    cleanup = testDb.cleanup
  })

  afterEach(async () => {
    await cleanup()
  })

  describe('schema and prices', () => {
    it('has the required keys, index, database clocks, and only the user cascade foreign key', async () => {
      const primaryKey = await client.query<{ column_name: string; ordinal_position: number }>(
        `select kcu.column_name, kcu.ordinal_position
         from information_schema.table_constraints tc
         join information_schema.key_column_usage kcu
           on kcu.constraint_name = tc.constraint_name
          and kcu.constraint_schema = tc.constraint_schema
         where tc.table_name = 'inference_prices'
           and tc.constraint_type = 'PRIMARY KEY'
         order by kcu.ordinal_position`,
      )
      const indexes = await client.query<{ indexdef: string }>(
        `select indexdef
         from pg_indexes
         where tablename = 'inference_usage'
           and indexname = 'inference_usage_user_id_created_at_idx'`,
      )
      const clockColumns = await client.query<{
        table_name: string
        column_name: string
        data_type: string
        column_default: string
      }>(
        `select table_name, column_name, data_type, column_default
         from information_schema.columns
         where (table_name = 'inference_prices' and column_name = 'updated_at')
            or (table_name = 'inference_usage' and column_name = 'created_at')
         order by table_name`,
      )
      const foreignKeys = await client.query<{
        column_name: string
        foreign_table_name: string
        delete_rule: string
      }>(
        `select kcu.column_name, ccu.table_name as foreign_table_name, rc.delete_rule
         from information_schema.table_constraints tc
         join information_schema.key_column_usage kcu
           on kcu.constraint_name = tc.constraint_name
          and kcu.constraint_schema = tc.constraint_schema
         join information_schema.referential_constraints rc
           on rc.constraint_name = tc.constraint_name
          and rc.constraint_schema = tc.constraint_schema
         join information_schema.constraint_column_usage ccu
           on ccu.constraint_name = rc.unique_constraint_name
          and ccu.constraint_schema = rc.unique_constraint_schema
         where tc.table_name = 'inference_usage'
           and tc.constraint_type = 'FOREIGN KEY'`,
      )

      expect(primaryKey.rows.map((row) => row.column_name)).toEqual(['provider', 'model'])
      expect(indexes.rows).toHaveLength(1)
      expect(indexes.rows[0]?.indexdef.replaceAll('"', '')).toContain('(user_id, created_at)')
      expect(clockColumns.rows).toEqual([
        {
          table_name: 'inference_prices',
          column_name: 'updated_at',
          data_type: 'timestamp with time zone',
          column_default: 'now()',
        },
        {
          table_name: 'inference_usage',
          column_name: 'created_at',
          data_type: 'timestamp with time zone',
          column_default: 'now()',
        },
      ])
      expect(foreignKeys.rows).toEqual([{ column_name: 'user_id', foreign_table_name: 'user', delete_rule: 'CASCADE' }])
    })

    it('keeps inference tables out of every PowerSync schema and sync-rule config', async () => {
      const repositoryRoot = resolve(import.meta.dir, '../../..')
      const powerSyncFiles = [
        'backend/src/db/powersync-schema.ts',
        'shared/powersync-tables.ts',
        'src/db/powersync/schema.ts',
        'src/db/tables.ts',
        'src/db/schema.ts',
        'powersync-service/config/config.yaml',
        'deploy/config/powersync-config.yaml',
        'deploy/k8s/templates/configmaps.yaml',
      ]
      const contents = await Promise.all(
        powerSyncFiles.map(async (file) => [file, await Bun.file(resolve(repositoryRoot, file)).text()] as const),
      )

      for (const [file, content] of contents) {
        expect(content, file).not.toContain('inference_prices')
        expect(content, file).not.toContain('inference_usage')
      }
    })

    it('uses PostgreSQL integer token columns and bigint money columns', async () => {
      const result = await client.query<{ column_name: string; data_type: string }>(
        `select column_name, data_type
         from information_schema.columns
         where table_name in ('inference_prices', 'inference_usage')
           and column_name in (
             'input_nano_usd_per_token',
             'output_nano_usd_per_token',
             'prompt_tokens',
             'completion_tokens',
             'total_tokens',
             'cost_nano_usd'
           )`,
      )
      const types = Object.fromEntries(result.rows.map((row) => [row.column_name, row.data_type]))

      expect(types).toEqual({
        input_nano_usd_per_token: 'bigint',
        output_nano_usd_per_token: 'bigint',
        prompt_tokens: 'integer',
        completion_tokens: 'integer',
        total_tokens: 'integer',
        cost_nano_usd: 'bigint',
      })
    })

    it('loads all three exact canonical current prices', async () => {
      expect(await loadInferencePrice(database, deepseekIdentity)).toEqual({
        ...deepseekIdentity,
        inputNanoUsdPerToken: 300n,
        outputNanoUsdPerToken: 700n,
      })
      expect(await loadInferencePrice(database, opusIdentity)).toEqual({
        ...opusIdentity,
        inputNanoUsdPerToken: 5_000n,
        outputNanoUsdPerToken: 25_000n,
      })
      expect(await loadInferencePrice(database, glmIdentity)).toEqual({
        ...glmIdentity,
        inputNanoUsdPerToken: 1_500n,
        outputNanoUsdPerToken: 5_250n,
      })
    })

    it('returns null when the exact canonical price is missing', async () => {
      expect(await loadInferencePrice(database, { provider: 'tinfoil', model: 'missing-model' })).toBeNull()
      expect(await loadInferencePrice(database, { provider: 'anthropic', model: 'deepseek-v4-flash' })).toBeNull()
    })

    it('rejects negative rates with database constraints', async () => {
      await expect(
        Promise.resolve(
          database.insert(inferencePrices).values({
            provider: 'test',
            model: 'negative-input',
            inputNanoUsdPerToken: -1n,
            outputNanoUsdPerToken: 0n,
          }),
        ),
      ).rejects.toThrow()
      await expect(
        Promise.resolve(
          database.insert(inferencePrices).values({
            provider: 'test',
            model: 'negative-output',
            inputNanoUsdPerToken: 0n,
            outputNanoUsdPerToken: -1n,
          }),
        ),
      ).rejects.toThrow()
    })
  })

  describe('cost calculation', () => {
    it('calculates exact costs for all canonical price fixtures', () => {
      expect(
        calculateInferenceCost(
          { promptTokens: 10_000, completionTokens: 10_000, totalTokens: 20_000 },
          { ...deepseekIdentity, inputNanoUsdPerToken: 300n, outputNanoUsdPerToken: 700n },
        ),
      ).toBe(10_000_000n)
      expect(
        calculateInferenceCost(
          { promptTokens: 5_000, completionTokens: 1_000, totalTokens: 6_000 },
          { ...opusIdentity, inputNanoUsdPerToken: 5_000n, outputNanoUsdPerToken: 25_000n },
        ),
      ).toBe(50_000_000n)
      expect(
        calculateInferenceCost(
          { promptTokens: 10_000, completionTokens: 5_000, totalTokens: 15_000 },
          { ...glmIdentity, inputNanoUsdPerToken: 1_500n, outputNanoUsdPerToken: 5_250n },
        ),
      ).toBe(41_250_000n)
    })

    it('prices only prompt and completion tokens even when optional details exist', () => {
      const counts = {
        promptTokens: 2,
        completionTokens: 3,
        totalTokens: 999,
        cachedInputTokens: 800,
        reasoningTokens: 700,
      }
      const price = { ...deepseekIdentity, inputNanoUsdPerToken: 300n, outputNanoUsdPerToken: 700n }

      expect(calculateInferenceCost(counts, price)).toBe(2_700n)
    })

    it('accepts the signed PostgreSQL bigint maximum and rejects overflow', () => {
      const counts = { promptTokens: 1, completionTokens: 0, totalTokens: 1 }

      expect(
        calculateInferenceCost(counts, {
          ...deepseekIdentity,
          inputNanoUsdPerToken: postgresBigintMax,
          outputNanoUsdPerToken: 0n,
        }),
      ).toBe(postgresBigintMax)
      expect(() =>
        calculateInferenceCost(counts, {
          ...deepseekIdentity,
          inputNanoUsdPerToken: postgresBigintMax + 1n,
          outputNanoUsdPerToken: 0n,
        }),
      ).toThrow(InferenceCostOverflowError)
    })
  })

  describe('recording', () => {
    it('persists canonical identity and an anonymous user ID', async () => {
      const userId = 'anonymous-ledger-user'
      await insertUser(database, userId, true)
      const price = await loadRequiredPrice(database, glmIdentity)

      expect(await recordInferenceUsage(database, usageInput('anonymous-usage', userId, price))).toBe('inserted')

      const rows = await database.select().from(inferenceUsage).where(eq(inferenceUsage.id, 'anonymous-usage'))
      expect(rows[0]).toMatchObject({
        id: 'anonymous-usage',
        userId,
        provider: 'tinfoil',
        model: 'glm-5-2',
        promptTokens: 10,
        completionTokens: 20,
        totalTokens: 30,
        costNanoUsd: 120_000n,
      })
    })

    it('retains the first values on sequential replay', async () => {
      const userId = 'sequential-replay-user'
      await insertUser(database, userId)
      const price = await loadRequiredPrice(database, deepseekIdentity)

      expect(await recordInferenceUsage(database, usageInput('sequential-replay', userId, price))).toBe('inserted')
      expect(
        await recordInferenceUsage(
          database,
          usageInput('sequential-replay', userId, price, {
            promptTokens: 999,
            completionTokens: 999,
            totalTokens: 999,
          }),
        ),
      ).toBe('duplicate')

      const [row] = await database.select().from(inferenceUsage).where(eq(inferenceUsage.id, 'sequential-replay'))
      expect(row).toMatchObject({ promptTokens: 10, completionTokens: 20, totalTokens: 30, costNanoUsd: 17_000n })
    })

    it('stores one row under concurrent replay', async () => {
      const userId = 'concurrent-replay-user'
      await insertUser(database, userId)
      const price = await loadRequiredPrice(database, deepseekIdentity)
      const input = usageInput('concurrent-replay', userId, price)

      const results = await Promise.all([recordInferenceUsage(database, input), recordInferenceUsage(database, input)])
      const rows = await database.select().from(inferenceUsage).where(eq(inferenceUsage.id, input.id))

      expect(results.sort()).toEqual(['duplicate', 'inserted'])
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({ promptTokens: 10, completionTokens: 20, totalTokens: 30 })
    })

    it('accepts the PostgreSQL integer maximum and rejects the next safe integer before insertion', async () => {
      const userId = 'integer-boundary-user'
      await insertUser(database, userId)
      const zeroPrice: InferencePrice = {
        ...deepseekIdentity,
        inputNanoUsdPerToken: 0n,
        outputNanoUsdPerToken: 0n,
      }

      expect(
        await recordInferenceUsage(
          database,
          usageInput('integer-max', userId, zeroPrice, {
            promptTokens: maxPostgresInteger,
            completionTokens: maxPostgresInteger,
            totalTokens: maxPostgresInteger,
          }),
        ),
      ).toBe('inserted')

      await expect(
        recordInferenceUsage(
          database,
          usageInput('integer-overflow', userId, zeroPrice, {
            promptTokens: maxPostgresInteger + 1,
            completionTokens: 0,
            totalTokens: maxPostgresInteger + 1,
          }),
        ),
      ).rejects.toBeInstanceOf(InferenceTokenCountOutOfRangeError)
      expect(
        await database.select().from(inferenceUsage).where(eq(inferenceUsage.id, 'integer-overflow')),
      ).toHaveLength(0)
    })

    it('preserves the historical cost snapshot after a current price update', async () => {
      const userId = 'price-snapshot-user'
      await insertUser(database, userId)
      const originalPrice = await loadRequiredPrice(database, deepseekIdentity)
      await recordInferenceUsage(database, usageInput('price-snapshot', userId, originalPrice))

      await database
        .update(inferencePrices)
        .set({ inputNanoUsdPerToken: 900n, outputNanoUsdPerToken: 1_100n })
        .where(
          and(
            eq(inferencePrices.provider, deepseekIdentity.provider),
            eq(inferencePrices.model, deepseekIdentity.model),
          ),
        )

      expect(await loadInferencePrice(database, deepseekIdentity)).toEqual({
        ...deepseekIdentity,
        inputNanoUsdPerToken: 900n,
        outputNanoUsdPerToken: 1_100n,
      })
      const [historical] = await database.select().from(inferenceUsage).where(eq(inferenceUsage.id, 'price-snapshot'))
      expect(historical.costNanoUsd).toBe(17_000n)
    })

    it('rejects negative counts and costs with database constraints', async () => {
      const userId = 'negative-constraint-user'
      await insertUser(database, userId)
      const base = {
        userId,
        provider: 'tinfoil',
        model: 'deepseek-v4-flash',
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        costNanoUsd: 0n,
      }

      for (const values of [
        { ...base, id: 'negative-prompt', promptTokens: -1 },
        { ...base, id: 'negative-completion', completionTokens: -1 },
        { ...base, id: 'negative-total', totalTokens: -1 },
        { ...base, id: 'negative-cost', costNanoUsd: -1n },
      ]) {
        await expect(Promise.resolve(database.insert(inferenceUsage).values(values))).rejects.toThrow()
      }
    })

    it('cascades usage on user deletion without deleting prices', async () => {
      const userId = 'cascade-ledger-user'
      await insertUser(database, userId)
      const price = await loadRequiredPrice(database, opusIdentity)
      await recordInferenceUsage(database, usageInput('cascade-usage', userId, price))

      await database.delete(user).where(eq(user.id, userId))

      expect(await database.select().from(inferenceUsage).where(eq(inferenceUsage.userId, userId))).toHaveLength(0)
      expect(await loadInferencePrice(database, opusIdentity)).toEqual(price)
    })

    it('surfaces database failures to the caller', async () => {
      await database.execute(sql`drop table inference_prices`)

      await expect(loadInferencePrice(database, deepseekIdentity)).rejects.toThrow()
    })
  })

  describe('rolling quotas', () => {
    const insertSpend = async (userId: string, id: string, costNanoUsd: bigint, age: string) => {
      await database.execute(sql`
        insert into inference_usage (
          id, user_id, provider, model, prompt_tokens, completion_tokens, total_tokens, cost_nano_usd, created_at
        ) values (
          ${id}, ${userId}, 'tinfoil', 'deepseek-v4-flash', 0, 0, 0, ${costNanoUsd}, now() - ${age}::interval
        )
      `)
    }

    it('uses database-clock inclusive 5h and 7d boundaries', async () => {
      const userId = 'rolling-boundary-user'
      await insertUser(database, userId)
      await insertSpend(userId, 'inside-five', 1n, '4 hours 59 minutes')
      await insertSpend(userId, 'exact-five', 2n, '5 hours')
      await insertSpend(userId, 'outside-five', 4n, '5 hours 1 millisecond')
      await insertSpend(userId, 'exact-seven', 8n, '7 days')
      await insertSpend(userId, 'outside-seven', 16n, '7 days 1 millisecond')

      const decision = await checkInferenceQuota(database, userId, { fiveHourCents: 1, sevenDayCents: 1 })

      expect(decision.fiveHourSpentNanoUsd).toBe(3n)
      expect(decision.sevenDaySpentNanoUsd).toBe(15n)
      expect(decision.allowed).toBe(true)
    })

    it.each([
      ['below', oneCentNanoUsd - 1n, true],
      ['exactly at', oneCentNanoUsd, false],
      ['above', oneCentNanoUsd + 1n, false],
    ] as const)('%s the 5h limit', async (_label, costNanoUsd, allowed) => {
      const userId = `five-hour-${_label.replaceAll(' ', '-')}`
      await insertUser(database, userId)
      await insertSpend(userId, `${userId}-usage`, costNanoUsd, '1 hour')

      const decision = await checkInferenceQuota(database, userId, { fiveHourCents: 1, sevenDayCents: 10 })

      expect(decision.allowed).toBe(allowed)
      expect(decision.exceededWindow).toBe(allowed ? null : '5h')
    })

    it('gives 5h precedence when both windows are exceeded', async () => {
      const userId = 'both-windows-user'
      await insertUser(database, userId)
      await insertSpend(userId, 'both-windows-usage', oneCentNanoUsd, '1 hour')

      const decision = await checkInferenceQuota(database, userId, { fiveHourCents: 1, sevenDayCents: 1 })

      expect(decision.allowed).toBe(false)
      expect(decision.exceededWindow).toBe('5h')
    })

    it('reports a seven-day-only exceedance', async () => {
      const userId = 'seven-day-only-user'
      await insertUser(database, userId)
      await insertSpend(userId, 'seven-day-only-usage', oneCentNanoUsd, '6 hours')

      const decision = await checkInferenceQuota(database, userId, { fiveHourCents: 1, sevenDayCents: 1 })

      expect(decision.fiveHourSpentNanoUsd).toBe(0n)
      expect(decision.allowed).toBe(false)
      expect(decision.exceededWindow).toBe('7d')
    })

    it('uses one aggregate database statement for both windows', async () => {
      const userId = 'one-query-user'
      await insertUser(database, userId)
      let selectCalls = 0
      const countingDatabase = {
        insert: database.insert,
        select: ((fields) => {
          selectCalls += 1
          return database.select(fields)
        }) as InferenceDatabase['select'],
      }

      await checkInferenceQuota(countingDatabase, userId, { fiveHourCents: 1, sevenDayCents: 1 })

      expect(selectCalls).toBe(1)
    })

    it('starts the current-price and quota reads concurrently', async () => {
      let selectCalls = 0
      const concurrentDatabase = {
        insert: database.insert,
        select: ((fields) => {
          selectCalls += 1
          return database.select(fields)
        }) as InferenceDatabase['select'],
      }

      const admissionPromise = checkManagedInferenceAdmission(
        concurrentDatabase,
        deepseekIdentity,
        'concurrent-admission-user',
        { fiveHourCents: 1, sevenDayCents: 1 },
      )

      expect(selectCalls).toBe(2)
      expect(await admissionPromise).toEqual({
        outcome: 'allowed',
        price: { ...deepseekIdentity, inputNanoUsdPerToken: 300n, outputNanoUsdPerToken: 700n },
      })
    })

    it('preserves missing-price precedence when quota is also exceeded', async () => {
      const userId = 'missing-price-exceeded-quota-user'
      await insertUser(database, userId)
      await insertSpend(userId, 'missing-price-exceeded-quota-usage', oneCentNanoUsd, '1 hour')
      await database
        .delete(inferencePrices)
        .where(
          and(
            eq(inferencePrices.provider, deepseekIdentity.provider),
            eq(inferencePrices.model, deepseekIdentity.model),
          ),
        )

      expect(
        await checkManagedInferenceAdmission(database, deepseekIdentity, userId, {
          fiveHourCents: 1,
          sevenDayCents: 1,
        }),
      ).toEqual({ outcome: 'price-unavailable' })
    })

    it('combines costs from all three canonical models in one user budget', async () => {
      const userId = 'shared-model-budget-user'
      await insertUser(database, userId)
      const fixtures = [
        [deepseekIdentity, 'shared-deepseek', { promptTokens: 10_000, completionTokens: 10_000, totalTokens: 20_000 }],
        [opusIdentity, 'shared-opus', { promptTokens: 5_000, completionTokens: 1_000, totalTokens: 6_000 }],
        [glmIdentity, 'shared-glm', { promptTokens: 10_000, completionTokens: 5_000, totalTokens: 15_000 }],
      ] as const

      for (const [identity, id, counts] of fixtures) {
        const price = await loadRequiredPrice(database, identity)
        await recordInferenceUsage(database, usageInput(id, userId, price, counts))
      }

      const decision = await checkInferenceQuota(database, userId, { fiveHourCents: 10, sevenDayCents: 100 })

      expect(decision.fiveHourSpentNanoUsd).toBe(101_250_000n)
      expect(decision.sevenDaySpentNanoUsd).toBe(101_250_000n)
      expect(decision.allowed).toBe(false)
      expect(decision.exceededWindow).toBe('5h')
    })

    it('selects anonymous and registered quota limits', () => {
      const settings = {
        inferenceQuotaAnonymousFiveHourCents: 10,
        inferenceQuotaAnonymousSevenDayCents: 60,
        inferenceQuotaRegisteredFiveHourCents: 1_500,
        inferenceQuotaRegisteredSevenDayCents: 7_500,
      }

      expect(getInferenceQuotaLimits(settings, true)).toEqual({ fiveHourCents: 10, sevenDayCents: 60 })
      expect(getInferenceQuotaLimits(settings, false)).toEqual({ fiveHourCents: 1_500, sevenDayCents: 7_500 })
    })
  })
})
