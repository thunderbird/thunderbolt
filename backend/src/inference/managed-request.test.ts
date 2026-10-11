/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { createTestSettings } from '@/test-utils/settings'
import type { LanguageModelUsage } from 'ai'
import { describe, expect, it, mock } from 'bun:test'
import type { Context } from 'elysia'
import {
  admitManagedRequest,
  createUsageCallbacks,
  recordLanguageModelUsage,
  type UsageTelemetry,
} from './managed-request'
import type {
  checkManagedInferenceAdmission,
  InferenceDatabase,
  InferencePrice,
  recordInferenceUsage,
} from './usage-ledger'

const database = {} as InferenceDatabase
const identity = { provider: 'anthropic', model: 'claude-test' } as const
const price: InferencePrice = { ...identity, inputNanoUsdPerToken: 1n, outputNanoUsdPerToken: 2n }

describe('admitManagedRequest', () => {
  const admit = (checkAdmission: typeof checkManagedInferenceAdmission, isAnonymous = false) => {
    const set: Pick<Context['set'], 'status'> = {}
    const logger = { info: mock(), error: mock() }
    const result = admitManagedRequest({
      database,
      settings: createTestSettings({ inferenceQuotaAnonymousFiveHourCents: 7 }),
      identity,
      user: { id: 'user-1', isAnonymous },
      set,
      logger,
      checkAdmission,
    })
    return { result, set, logger }
  }

  it('returns the price of an admitted request, checked against the quota of its user kind', async () => {
    const checkAdmission = mock<typeof checkManagedInferenceAdmission>(async () => ({ outcome: 'allowed', price }))
    const { result, set } = admit(checkAdmission, true)
    expect(await result).toEqual({ price })
    expect(set.status).toBeUndefined()
    expect(checkAdmission.mock.calls[0].slice(1)).toEqual([
      identity,
      'user-1',
      expect.objectContaining({ fiveHourCents: 7 }),
    ])
  })

  it('maps a missing price to a logged 503 that the access log also sees', async () => {
    const { result, set, logger } = admit(async () => ({ outcome: 'price-unavailable' }))
    const response = (await result) as Response
    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({ error: { code: 'INFERENCE_PRICE_UNAVAILABLE' } })
    expect(set.status).toBe(503)
    expect(logger.error).toHaveBeenCalledWith(
      { event: 'inference_price_unavailable', provider: 'anthropic', model: 'claude-test' },
      'Inference price unavailable',
    )
  })

  it('maps an exhausted quota to 429 with its window', async () => {
    const { result, set, logger } = admit(async (_db, _identity, _userId, limits) => ({
      outcome: 'quota-exceeded',
      decision: { allowed: false, exceededWindow: '7d', fiveHourSpentNanoUsd: 0n, sevenDaySpentNanoUsd: 0n, limits },
    }))
    const response = (await result) as Response
    expect(response.status).toBe(429)
    expect(await response.json()).toEqual({ error: { code: 'INFERENCE_QUOTA_EXCEEDED', window: '7d' } })
    expect(set.status).toBe(429)
    expect(logger.error).not.toHaveBeenCalled()
  })
})

describe('createUsageCallbacks', () => {
  const createTelemetry = () => ({
    onUsageRecording: mock(),
    onUsageRecorded: mock(),
    onUsageMissing: mock(),
    onUsageError: mock(),
  })
  const createCallbacks = (telemetry: UsageTelemetry, recordUsage: typeof recordInferenceUsage) =>
    createUsageCallbacks({ database, eventId: 'event-1', userId: 'user-1', price, telemetry, recordUsage })

  const usage = (inputTokens: number | undefined): LanguageModelUsage => ({
    inputTokens,
    outputTokens: 4,
    totalTokens: undefined,
    inputTokenDetails: { noCacheTokens: undefined, cacheReadTokens: 2, cacheWriteTokens: 1 },
    outputTokenDetails: { textTokens: 4, reasoningTokens: undefined },
  })

  it('writes the run to the ledger at the admitted price', async () => {
    const telemetry = createTelemetry()
    const recordUsage = mock<typeof recordInferenceUsage>(async () => 'inserted')
    await recordLanguageModelUsage(createCallbacks(telemetry, recordUsage), usage(10))
    expect(recordUsage).toHaveBeenCalledWith(database, {
      id: 'event-1',
      userId: 'user-1',
      price,
      counts: { promptTokens: 10, completionTokens: 4, totalTokens: 14, cacheCreationTokens: 1, cacheReadTokens: 2 },
    })
    expect(telemetry.onUsageRecording).toHaveBeenCalledTimes(1)
    expect(telemetry.onUsageRecorded).toHaveBeenCalledWith('inserted')
  })

  it('writes the run when the route has no recorded hook', async () => {
    const recordUsage = mock<typeof recordInferenceUsage>(async () => 'inserted')
    const telemetry = { onUsageMissing: mock(), onUsageError: mock() }
    await recordLanguageModelUsage(createCallbacks(telemetry, recordUsage), usage(10))
    expect(recordUsage).toHaveBeenCalledTimes(1)
  })

  it('still writes the run when a telemetry hook throws', async () => {
    const recordUsage = mock<typeof recordInferenceUsage>(async () => 'inserted')
    const telemetry = {
      ...createTelemetry(),
      onUsageRecording: () => {
        throw new Error('logger down')
      },
    }
    await recordLanguageModelUsage(createCallbacks(telemetry, recordUsage), usage(10))
    expect(recordUsage).toHaveBeenCalledTimes(1)
    expect(telemetry.onUsageRecorded).toHaveBeenCalledWith('inserted')
    expect(telemetry.onUsageError).not.toHaveBeenCalled()
  })

  it('skips the ledger when the provider reports no usage', async () => {
    const telemetry = createTelemetry()
    const recordUsage = mock<typeof recordInferenceUsage>(async () => 'inserted')
    await recordLanguageModelUsage(createCallbacks(telemetry, recordUsage), usage(undefined))
    expect(recordUsage).not.toHaveBeenCalled()
    expect(telemetry.onUsageMissing).toHaveBeenCalledTimes(1)
  })

  it('reports a failed ledger write instead of throwing', async () => {
    const telemetry = createTelemetry()
    const failure = new Error('insert failed')
    await recordLanguageModelUsage(
      createCallbacks(telemetry, async () => {
        throw failure
      }),
      usage(10),
    )
    expect(telemetry.onUsageError).toHaveBeenCalledWith(failure)
    expect(telemetry.onUsageRecorded).not.toHaveBeenCalled()
  })
})
