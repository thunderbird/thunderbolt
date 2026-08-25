/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { Settings } from '@/config/settings'
import type { db } from '@/db/client'
import { inferencePrices, inferenceUsage } from '@/db/inference-usage-schema'
import { and, eq, gte, sql } from 'drizzle-orm'

export type ManagedInferenceIdentity = Readonly<{ provider: 'anthropic' | 'tinfoil'; model: string }>
export type InferenceTokenCounts = Readonly<{
  promptTokens: number
  completionTokens: number
  totalTokens: number
}>
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
export type ManagedInferenceAdmission =
  | Readonly<{ outcome: 'allowed'; price: InferencePrice }>
  | Readonly<{ outcome: 'price-unavailable' }>
  | Readonly<{ outcome: 'quota-exceeded'; decision: Extract<InferenceQuotaDecision, { allowed: false }> }>
export type InferenceDatabase = Pick<typeof db, 'insert' | 'select'>
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
    })
    .from(inferencePrices)
    .where(and(eq(inferencePrices.provider, identity.provider), eq(inferencePrices.model, identity.model)))
    .limit(1)

  return price ? { ...identity, ...price } : null
}

/** Calculate exact usage cost from prompt and completion tokens. */
export const calculateInferenceCost = (counts: InferenceTokenCounts, price: InferencePrice): bigint => {
  const cost =
    BigInt(counts.promptTokens) * price.inputNanoUsdPerToken +
    BigInt(counts.completionTokens) * price.outputNanoUsdPerToken
  if (cost > postgresBigintMax) {
    throw new InferenceCostOverflowError()
  }
  return cost
}

/** Insert one completed usage event, treating an existing event ID as a replay. */
export const recordInferenceUsage = async (
  database: InferenceDatabase,
  input: RecordInferenceUsageInput,
): Promise<'inserted' | 'duplicate'> => {
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
    .returning()

  return rows.length === 1 ? 'inserted' : 'duplicate'
}

/** Read both rolling spend windows with one database-clock aggregate query. */
export const checkInferenceQuota = async (
  database: InferenceDatabase,
  userId: string,
  limits: InferenceQuotaLimits,
): Promise<InferenceQuotaDecision> => {
  const [aggregate] = await database
    .select({
      fiveHourSpentNanoUsd:
        sql`coalesce(sum(${inferenceUsage.costNanoUsd}) filter (where ${inferenceUsage.createdAt} >= now() - interval '5 hours'), 0)::bigint`.mapWith(
          inferenceUsage.costNanoUsd,
        ),
      sevenDaySpentNanoUsd:
        sql`coalesce(sum(${inferenceUsage.costNanoUsd}) filter (where ${inferenceUsage.createdAt} >= now() - interval '7 days'), 0)::bigint`.mapWith(
          inferenceUsage.costNanoUsd,
        ),
    })
    .from(inferenceUsage)
    .where(and(eq(inferenceUsage.userId, userId), gte(inferenceUsage.createdAt, sql`now() - interval '7 days'`)))
  const { fiveHourSpentNanoUsd, sevenDaySpentNanoUsd } = aggregate
  const fiveHourExceeded = fiveHourSpentNanoUsd >= BigInt(limits.fiveHourCents) * nanoUsdPerCent
  const sevenDayExceeded = sevenDaySpentNanoUsd >= BigInt(limits.sevenDayCents) * nanoUsdPerCent
  const exceededWindow = fiveHourExceeded ? '5h' : sevenDayExceeded ? '7d' : null
  const spend = { fiveHourSpentNanoUsd, sevenDaySpentNanoUsd, limits }

  return exceededWindow
    ? { allowed: false, exceededWindow, ...spend }
    : { allowed: true, exceededWindow: null, ...spend }
}

/** Load the current price and rolling spend concurrently, with price errors taking precedence. */
export const checkManagedInferenceAdmission = async (
  database: InferenceDatabase,
  identity: ManagedInferenceIdentity,
  userId: string,
  limits: InferenceQuotaLimits,
): Promise<ManagedInferenceAdmission> => {
  const [priceResult, quotaResult] = await Promise.allSettled([
    loadInferencePrice(database, identity),
    checkInferenceQuota(database, userId, limits),
  ])

  if (priceResult.status === 'rejected') {
    throw priceResult.reason
  }
  if (priceResult.value === null) {
    return { outcome: 'price-unavailable' }
  }
  if (quotaResult.status === 'rejected') {
    throw quotaResult.reason
  }
  if (!quotaResult.value.allowed) {
    return { outcome: 'quota-exceeded', decision: quotaResult.value }
  }
  return { outcome: 'allowed', price: priceResult.value }
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
