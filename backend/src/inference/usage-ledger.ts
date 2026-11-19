/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { Settings } from '@/config/settings'
import type { db } from '@/db/client'
import { inferencePrices, inferenceUsage } from '@/db/inference-usage-schema'
import { and, eq, gte, inArray, sql } from 'drizzle-orm'

export type ManagedInferenceIdentity = Readonly<{ provider: 'anthropic' | 'fireworks' | 'tinfoil'; model: string }>
export type InferenceTokenCounts = Readonly<{
  promptTokens: number
  completionTokens: number
  totalTokens: number
  cacheCreationTokens?: number
  cacheCreation1hTokens?: number
  cacheReadTokens?: number
}>
export type InferencePrice = ManagedInferenceIdentity &
  Readonly<{
    inputNanoUsdPerToken: bigint
    outputNanoUsdPerToken: bigint
    /** The provider's cached-input rate; absent means cache reads bill at the input rate (Anthropic: a tenth of it). */
    cacheReadNanoUsdPerToken?: bigint
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
export type ManagedInferenceAdmission =
  | Readonly<{ outcome: 'allowed'; price: InferencePrice }>
  | Readonly<{ outcome: 'price-unavailable' }>
  | Readonly<{ outcome: 'quota-exceeded'; decision: Extract<InferenceQuotaDecision, { allowed: false }> }>
  /** Below the limit, but the request does not fit beside the user's requests still running. */
  | Readonly<{ outcome: 'request-in-progress' }>
export type InferenceDatabase = Pick<typeof db, 'insert' | 'select'>
/** What admission and a hold's end need: admission opens a transaction, release deletes a hold, retain updates it. */
export type InferenceLedgerDatabase = InferenceDatabase & Pick<typeof db, 'delete' | 'transaction' | 'update'>
/** The hold admission records for a request: a ledger row written before the provider is called. */
export type InferenceHold = Readonly<{
  /** The request's usage event ID. The request's usage settles the hold under this ID. */
  id: string
  /** The most the request can cost at `price`. Its hold charges this, capped at what is left of the limit. */
  maxCostNanoUsd: (price: InferencePrice) => bigint
}>
export type RecordInferenceUsageInput = Readonly<{
  id: string
  userId: string
  counts: InferenceTokenCounts
  price: InferencePrice
}>

const postgresBigintMax = 9_223_372_036_854_775_807n
const nanoUsdPerCent = 10_000_000n

export const maxPostgresInteger = 2_147_483_647

export class InferenceTokenCountOutOfRangeError extends Error {}
export class InferenceCostOverflowError extends Error {}

/** Load the exact current price for a canonical provider and model. */
export const loadInferencePrice = async (
  database: InferenceDatabase,
  identity: ManagedInferenceIdentity,
): Promise<InferencePrice | null> => {
  const [price] = await database
    .select({
      inputNanoUsdPerToken: inferencePrices.inputNanoUsdPerToken,
      outputNanoUsdPerToken: inferencePrices.outputNanoUsdPerToken,
      cacheReadNanoUsdPerToken: inferencePrices.cacheReadNanoUsdPerToken,
    })
    .from(inferencePrices)
    .where(and(eq(inferencePrices.provider, identity.provider), eq(inferencePrices.model, identity.model)))
    .limit(1)
  if (!price) {
    return null
  }

  const { cacheReadNanoUsdPerToken, ...rates } = price
  return cacheReadNanoUsdPerToken === null
    ? { ...identity, ...rates }
    : { ...identity, ...rates, cacheReadNanoUsdPerToken }
}

/**
 * Cost of the cache-read tokens: the row's cached-input rate when it has one, otherwise Anthropic's tenth of
 * the input rate. Any other provider without a rate bills them as ordinary input, as before the column existed.
 */
const cacheReadCost = (cacheReadTokens: number, price: InferencePrice): bigint => {
  if (price.cacheReadNanoUsdPerToken !== undefined) {
    return BigInt(cacheReadTokens) * price.cacheReadNanoUsdPerToken
  }
  if (price.provider === 'anthropic') {
    return (BigInt(cacheReadTokens) * price.inputNanoUsdPerToken) / 10n
  }
  return BigInt(cacheReadTokens) * price.inputNanoUsdPerToken
}

/** Calculate usage cost, applying Anthropic's cache write multipliers and each row's cache-read rate. */
export const calculateInferenceCost = (counts: InferenceTokenCounts, price: InferencePrice): bigint => {
  const cacheCreationTokens = price.provider === 'anthropic' ? (counts.cacheCreationTokens ?? 0) : 0
  const cacheCreation1hTokens = price.provider === 'anthropic' ? (counts.cacheCreation1hTokens ?? 0) : 0
  const cacheReadTokens = counts.cacheReadTokens ?? 0
  const uncachedPromptTokens = counts.promptTokens - cacheCreationTokens - cacheReadTokens
  const cacheCreation5mTokens = cacheCreationTokens - cacheCreation1hTokens
  if (uncachedPromptTokens < 0 || cacheCreation5mTokens < 0) {
    throw new InferenceTokenCountOutOfRangeError()
  }
  const cost =
    BigInt(uncachedPromptTokens) * price.inputNanoUsdPerToken +
    (BigInt(cacheCreation5mTokens) * price.inputNanoUsdPerToken * 5n) / 4n +
    BigInt(cacheCreation1hTokens) * price.inputNanoUsdPerToken * 2n +
    cacheReadCost(cacheReadTokens, price) +
    BigInt(counts.completionTokens) * price.outputNanoUsdPerToken
  if (cost > postgresBigintMax) {
    throw new InferenceCostOverflowError()
  }
  return cost
}

/**
 * The most a request can cost: every prompt token billed at the highest input rate the provider bills (for
 * Anthropic, the one-hour cache write at twice the input price) and every allowed output token.
 */
export const calculateMaxInferenceCost = (
  price: InferencePrice,
  promptTokens: number,
  completionTokens: number,
): bigint =>
  calculateInferenceCost(
    {
      promptTokens,
      completionTokens,
      totalTokens: promptTokens + completionTokens,
      cacheCreationTokens: promptTokens,
      cacheCreation1hTokens: promptTokens,
    },
    price,
  )

/**
 * Record a request's usage, settling its hold. The first record wins: recording an event that is already settled is
 * a replay, so a retry or a second report cannot change the charge.
 */
export const recordInferenceUsage = async (
  database: InferenceDatabase,
  input: RecordInferenceUsageInput,
): Promise<'inserted' | 'duplicate'> => {
  if (Object.values(input.counts).some((count) => count > maxPostgresInteger)) {
    throw new InferenceTokenCountOutOfRangeError()
  }

  const usage = {
    provider: input.price.provider,
    model: input.price.model,
    promptTokens: input.counts.promptTokens,
    completionTokens: input.counts.completionTokens,
    totalTokens: input.counts.totalTokens,
    costNanoUsd: calculateInferenceCost(input.counts, input.price),
    settled: true,
  }
  const rows = await database
    .insert(inferenceUsage)
    .values({ id: input.id, userId: input.userId, ...usage })
    .onConflictDoUpdate({ target: inferenceUsage.id, set: usage, setWhere: eq(inferenceUsage.settled, false) })
    .returning()

  return rows.length === 1 ? 'inserted' : 'duplicate'
}

/**
 * Delete the hold of a request that never reached the provider or that the provider refused, so it costs nothing. A
 * settled row is never touched.
 */
export const releaseInferenceHold = (database: InferenceLedgerDatabase, id: string): Promise<void> =>
  releaseInferenceHolds(database, [id])

/** Release several holds at once, as {@link releaseInferenceHold} releases one. */
export const releaseInferenceHolds = async (
  database: InferenceLedgerDatabase,
  ids: readonly string[],
): Promise<void> => {
  await database
    .delete(inferenceUsage)
    .where(and(inArray(inferenceUsage.id, [...ids]), eq(inferenceUsage.settled, false)))
}

/**
 * Keep the hold of a request that ended without usage as its charge. The row is marked settled at the cost it held,
 * so it no longer counts as a request still running. A settled row is never touched.
 */
export const retainInferenceHold = async (database: InferenceLedgerDatabase, id: string): Promise<void> => {
  await database
    .update(inferenceUsage)
    .set({ settled: true })
    .where(and(eq(inferenceUsage.id, id), eq(inferenceUsage.settled, false)))
}

type InferenceSpend = Readonly<{ fiveHourSpentNanoUsd: bigint; sevenDaySpentNanoUsd: bigint; heldRequests: number }>

/**
 * Read both rolling windows' spend, holds included, and the number of unsettled holds from the last 5 hours, whose
 * requests may still be running. One database-clock aggregate query reads all three.
 */
const readInferenceSpend = async (database: InferenceDatabase, userId: string): Promise<InferenceSpend> => {
  const [spend] = await database
    .select({
      fiveHourSpentNanoUsd:
        sql`coalesce(sum(${inferenceUsage.costNanoUsd}) filter (where ${inferenceUsage.createdAt} >= now() - interval '5 hours'), 0)::bigint`.mapWith(
          inferenceUsage.costNanoUsd,
        ),
      sevenDaySpentNanoUsd:
        sql`coalesce(sum(${inferenceUsage.costNanoUsd}) filter (where ${inferenceUsage.createdAt} >= now() - interval '7 days'), 0)::bigint`.mapWith(
          inferenceUsage.costNanoUsd,
        ),
      heldRequests:
        sql`count(*) filter (where not ${inferenceUsage.settled} and ${inferenceUsage.createdAt} >= now() - interval '5 hours')`.mapWith(
          Number,
        ),
    })
    .from(inferenceUsage)
    .where(and(eq(inferenceUsage.userId, userId), gte(inferenceUsage.createdAt, sql`now() - interval '7 days'`)))
  return spend
}

const centsToNanoUsd = (cents: number): bigint => BigInt(cents) * nanoUsdPerCent

/** Decide a request alone: it is admitted while both windows are below their limits. */
const decideQuota = (
  { fiveHourSpentNanoUsd, sevenDaySpentNanoUsd }: InferenceSpend,
  limits: InferenceQuotaLimits,
): InferenceQuotaDecision => {
  const fiveHourExceeded = fiveHourSpentNanoUsd >= centsToNanoUsd(limits.fiveHourCents)
  const sevenDayExceeded = sevenDaySpentNanoUsd >= centsToNanoUsd(limits.sevenDayCents)
  const exceededWindow = fiveHourExceeded ? '5h' : sevenDayExceeded ? '7d' : null
  const spend = { fiveHourSpentNanoUsd, sevenDaySpentNanoUsd, limits }

  return exceededWindow
    ? { allowed: false, exceededWindow, ...spend }
    : { allowed: true, exceededWindow: null, ...spend }
}

/** Read both rolling spend windows, holds included, with one database-clock aggregate query. */
export const checkInferenceQuota = async (
  database: InferenceDatabase,
  userId: string,
  limits: InferenceQuotaLimits,
): Promise<InferenceQuotaDecision> => decideQuota(await readInferenceSpend(database, userId), limits)

/**
 * Admit a request against the user's rolling quota and record its hold in the same transaction. A per-user
 * advisory lock serializes admissions across every backend process, so each admission sees the holds of the
 * requests still running. Admission never lets settled spend plus holds pass a limit:
 *
 * - Beside requests still running, a request is admitted only if its whole maximum cost fits in what is left.
 *   Otherwise it is refused as `request-in-progress`, because it is admitted alone once those requests end, unless
 *   their usage reaches the limit.
 * - Alone, a request is admitted while both windows are below their limits, and its hold is at most what is left.
 *   Its usage can still take spend past the limit by up to its own cost.
 *
 * A hold is charged until usage settles it. A request that ends without usage keeps its hold as its charge
 * ({@link retainInferenceHold}). The retained hold then counts as spent quota, not as a request still running. A
 * hold stays unsettled when its process dies first, so only holds from the last 5 hours count as requests still
 * running. An older hold stops crowding out new requests, though the 7-day window still charges it.
 */
export const checkManagedInferenceAdmission = async (
  database: InferenceLedgerDatabase,
  identity: ManagedInferenceIdentity,
  userId: string,
  limits: InferenceQuotaLimits,
  hold: InferenceHold,
): Promise<ManagedInferenceAdmission> => {
  const price = await loadInferencePrice(database, identity)
  if (!price) {
    return { outcome: 'price-unavailable' }
  }
  const requestMaxNanoUsd = hold.maxCostNanoUsd(price)

  return database.transaction(async (tx) => {
    // `hashtext` is 32 bits, so two users can share a lock; they then only wait on each other's admissions.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`inference-quota:${userId}`})::bigint)`)
    const spend = await readInferenceSpend(tx, userId)
    const fiveHourLeftNanoUsd = centsToNanoUsd(limits.fiveHourCents) - spend.fiveHourSpentNanoUsd
    const sevenDayLeftNanoUsd = centsToNanoUsd(limits.sevenDayCents) - spend.sevenDaySpentNanoUsd
    const leftNanoUsd = fiveHourLeftNanoUsd < sevenDayLeftNanoUsd ? fiveHourLeftNanoUsd : sevenDayLeftNanoUsd
    // This runs before the limit check. A lone hold capped at what is left fills the limit, but only until its
    // request ends.
    if (spend.heldRequests > 0 && requestMaxNanoUsd > leftNanoUsd) {
      return { outcome: 'request-in-progress' }
    }
    const decision = decideQuota(spend, limits)
    if (!decision.allowed) {
      return { outcome: 'quota-exceeded', decision }
    }
    await tx.insert(inferenceUsage).values({
      id: hold.id,
      userId,
      provider: price.provider,
      model: price.model,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      costNanoUsd: requestMaxNanoUsd < leftNanoUsd ? requestMaxNanoUsd : leftNanoUsd,
      settled: false,
    })
    return { outcome: 'allowed', price }
  })
}

/** Select quota limits for an anonymous or registered user. */
export const getInferenceQuotaLimits = (
  settings: Pick<
    Settings,
    | 'inferenceQuotaAnonymousFiveHourCents'
    | 'inferenceQuotaAnonymousSevenDayCents'
    | 'inferenceQuotaRegisteredFiveHourCents'
    | 'inferenceQuotaRegisteredSevenDayCents'
  >,
  isAnonymous: boolean,
): InferenceQuotaLimits => {
  if (isAnonymous) {
    return {
      fiveHourCents: settings.inferenceQuotaAnonymousFiveHourCents,
      sevenDayCents: settings.inferenceQuotaAnonymousSevenDayCents,
    }
  }
  return {
    fiveHourCents: settings.inferenceQuotaRegisteredFiveHourCents,
    sevenDayCents: settings.inferenceQuotaRegisteredSevenDayCents,
  }
}
