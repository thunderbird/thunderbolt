/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { createTestSettings } from '@/test-utils/settings'
import type { LanguageModelUsage } from 'ai'
import { describe, expect, it, mock } from 'bun:test'
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
  const admit = (checkAdmission: typeof checkManagedInferenceAdmission, isAnonymous = false) =>
    admitManagedRequest({
      database,
      settings: createTestSettings({ inferenceQuotaAnonymousFiveHourCents: 7 }),
      identity,
      user: { id: 'user-1', isAnonymous },
      checkAdmission,
    })

  it('returns the price of an admitted request, checked against the quota of its user kind', async () => {
    const checkAdmission = mock<typeof checkManagedInferenceAdmission>(async () => ({ outcome: 'allowed', price }))
    expect(await admit(checkAdmission, true)).toEqual({ price })
    expect(checkAdmission.mock.calls[0].slice(1)).toEqual([
      identity,
      'user-1',
      expect.objectContaining({ fiveHourCents: 7 }),
    ])
  })

  it('maps a missing price to 503', async () => {
    const response = (await admit(async () => ({ outcome: 'price-unavailable' }))) as Response
    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({ error: { code: 'INFERENCE_PRICE_UNAVAILABLE' } })
  })

  it('maps an exhausted quota to 429 with its window', async () => {
    const response = (await admit(async (_db, _identity, _userId, limits) => ({
      outcome: 'quota-exceeded',
      decision: { allowed: false, exceededWindow: '7d', fiveHourSpentNanoUsd: 0n, sevenDaySpentNanoUsd: 0n, limits },
    }))) as Response
    expect(response.status).toBe(429)
    expect(await response.json()).toEqual({ error: { code: 'INFERENCE_QUOTA_EXCEEDED', window: '7d' } })
  })
})

describe('createUsageCallbacks', () => {
  const createTelemetry = () => ({ onRecording: mock(), onRecorded: mock(), onMissing: mock(), onFailed: mock() })
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
    expect(telemetry.onRecording).toHaveBeenCalledTimes(1)
    expect(telemetry.onRecorded).toHaveBeenCalledWith('inserted')
  })

  it('writes the run when the route has no recorded hook', async () => {
    const recordUsage = mock<typeof recordInferenceUsage>(async () => 'inserted')
    const telemetry = { onMissing: mock(), onFailed: mock() }
    await recordLanguageModelUsage(createCallbacks(telemetry, recordUsage), usage(10))
    expect(recordUsage).toHaveBeenCalledTimes(1)
  })

  it('skips the ledger when the provider reports no usage', async () => {
    const telemetry = createTelemetry()
    const recordUsage = mock<typeof recordInferenceUsage>(async () => 'inserted')
    await recordLanguageModelUsage(createCallbacks(telemetry, recordUsage), usage(undefined))
    expect(recordUsage).not.toHaveBeenCalled()
    expect(telemetry.onMissing).toHaveBeenCalledTimes(1)
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
    expect(telemetry.onFailed).toHaveBeenCalledWith(failure)
    expect(telemetry.onRecorded).not.toHaveBeenCalled()
  })
})
