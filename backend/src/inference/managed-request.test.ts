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
  hasUnsizedContent,
  maxPromptTokens,
  recordLanguageModelUsage,
  releaseOpenHolds,
  type UsageTelemetry,
} from './managed-request'
import type {
  checkManagedInferenceAdmission,
  InferenceLedgerDatabase,
  InferencePrice,
  recordInferenceUsage,
  releaseInferenceHold,
  releaseInferenceHolds,
  retainInferenceHold,
} from './usage-ledger'

const database = {} as InferenceLedgerDatabase
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
      maxCostNanoUsd,
      logger,
      checkAdmission,
    })
    return { result, set, logger }
  }
  const maxCostNanoUsd = () => 1n

  it('returns the price and event ID of an admitted request, checked against the quota of its user kind', async () => {
    const checkAdmission = mock<typeof checkManagedInferenceAdmission>(async () => ({ outcome: 'allowed', price }))
    const { result, set } = admit(checkAdmission, true)
    const admitted = await result
    expect(set.status).toBeUndefined()
    expect(checkAdmission.mock.calls[0].slice(1)).toEqual([
      identity,
      'user-1',
      expect.objectContaining({ fiveHourCents: 7 }),
      { id: expect.any(String), maxCostNanoUsd },
    ])
    // The hold is recorded under the event ID the route's usage callbacks settle.
    expect(admitted).toEqual({ price, eventId: checkAdmission.mock.calls[0][4].id })
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

  it('maps a request that does not fit beside running ones to a 429 that is not a spent quota', async () => {
    const { result, set } = admit(async () => ({ outcome: 'request-in-progress' }))
    const response = (await result) as Response
    expect(response.status).toBe(429)
    expect(await response.json()).toEqual({ error: { code: 'INFERENCE_REQUEST_IN_PROGRESS' } })
    expect(set.status).toBe(429)
  })
})

describe('createUsageCallbacks', () => {
  const createTelemetry = () => ({
    onUsageRecording: mock(),
    onUsageRecorded: mock(),
    onUsageMissing: mock(),
    onUsageError: mock(),
  })
  const createCallbacks = (
    telemetry: UsageTelemetry,
    recordUsage: typeof recordInferenceUsage,
    releaseHold?: typeof releaseInferenceHold,
  ) =>
    createUsageCallbacks({ database, eventId: 'event-1', userId: 'user-1', price, telemetry, recordUsage, releaseHold })

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

  it('writes no usage when the provider reports none', async () => {
    const telemetry = createTelemetry()
    const recordUsage = mock<typeof recordInferenceUsage>(async () => 'inserted')
    await recordLanguageModelUsage(createCallbacks(telemetry, recordUsage), usage(undefined))
    expect(recordUsage).not.toHaveBeenCalled()
    expect(telemetry.onUsageMissing).toHaveBeenCalledTimes(1)
  })

  it('retries a failed ledger write with the same event ID', async () => {
    const telemetry = createTelemetry()
    const recordUsage = mock<typeof recordInferenceUsage>(async () => 'inserted')
    recordUsage.mockRejectedValueOnce(new Error('connection reset'))
    await recordLanguageModelUsage(createCallbacks(telemetry, recordUsage), usage(10))
    expect(recordUsage).toHaveBeenCalledTimes(2)
    expect(recordUsage.mock.calls.map(([, input]) => input.id)).toEqual(['event-1', 'event-1'])
    expect(telemetry.onUsageRecording).toHaveBeenCalledTimes(1)
    expect(telemetry.onUsageRecorded).toHaveBeenCalledWith('inserted')
    expect(telemetry.onUsageError).not.toHaveBeenCalled()
  })

  it('reports a ledger write that fails three times instead of throwing', async () => {
    const telemetry = createTelemetry()
    const failure = new Error('insert failed')
    const recordUsage = mock<typeof recordInferenceUsage>(async () => {
      throw failure
    })
    await recordLanguageModelUsage(createCallbacks(telemetry, recordUsage), usage(10))
    expect(recordUsage).toHaveBeenCalledTimes(3)
    expect(telemetry.onUsageError).toHaveBeenCalledTimes(1)
    expect(telemetry.onUsageError).toHaveBeenCalledWith(failure)
    expect(telemetry.onUsageRecorded).not.toHaveBeenCalled()
  })

  it('releases the hold of its own event', async () => {
    const releaseHold = mock<typeof releaseInferenceHold>(async () => {})
    await createCallbacks(createTelemetry(), mock(), releaseHold).release()
    expect(releaseHold).toHaveBeenCalledWith(database, 'event-1')
  })

  it('reports a release that fails three times instead of throwing, and the hold stays charged', async () => {
    const telemetry = createTelemetry()
    const failure = new Error('delete failed')
    const releaseHold = mock<typeof releaseInferenceHold>(async () => {
      throw failure
    })
    await createCallbacks(telemetry, mock(), releaseHold).release()
    expect(releaseHold).toHaveBeenCalledTimes(3)
    expect(telemetry.onUsageError).toHaveBeenCalledWith(failure)
  })
})

describe('hasUnsizedContent', () => {
  const image = (source: Record<string, string>) => ({ role: 'user', content: [{ type: 'image', source }] })

  it.each([
    ['a PDF document', { role: 'user', content: [{ type: 'document', source: { type: 'base64', data: 'JVBE' } }] }],
    ['an image fetched by URL', image({ type: 'url', url: 'https://example.com/a.png' })],
    ['a Files API image', image({ type: 'file', file_id: 'file_1' })],
    ['an upload by file ID', { role: 'user', content: [{ type: 'container_upload', file_id: 'file_1' }] }],
    [
      'a chat-completions image URL',
      { role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://x' } }] },
    ],
    [
      'a URL image inside a tool result',
      { role: 'user', content: [{ type: 'tool_result', content: [image({ type: 'url', url: 'https://x' })] }] },
    ],
    // A few bytes can encode a large image, which the provider bills by its pixels.
    ['an inline base64 image', image({ type: 'base64', media_type: 'image/png', data: 'iVBO' })],
    [
      'an inline data-URL image',
      { role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,iVBO' } }] },
    ],
  ])('flags %s', (_, message) => {
    expect(hasUnsizedContent(JSON.stringify({ messages: [message] }))).toBe(true)
  })

  it.each([
    ['plain text', { role: 'user', content: 'Summarize "type":"image" and "file_id":' }],
    [
      'a URL inside a tool call input',
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'fetch', input: { url: 'https://x' } }] },
    ],
  ])('does not flag %s', (_, message) => {
    expect(hasUnsizedContent(JSON.stringify({ messages: [message] }))).toBe(false)
  })
})

describe('maxPromptTokens', () => {
  it('counts one token per UTF-8 byte of the raw body', () => {
    const bodyText = JSON.stringify({ messages: [{ role: 'user', content: 'aé中😀' }] })
    expect(maxPromptTokens(bodyText, bodyText, 1_000_000)).toBe(new TextEncoder().encode(bodyText).length)
  })

  it('counts the whole context window for content its text does not bound', () => {
    const bodyText = JSON.stringify({ messages: [{ role: 'user', content: [{ type: 'document', source: {} }] }] })
    expect(maxPromptTokens(bodyText, bodyText, 200_000)).toBe(200_000)
  })
})

describe('the end of a held request', () => {
  const counts = { promptTokens: 1, completionTokens: 1, totalTokens: 2 }
  const admitHeld = async () => {
    const admitted = await admitManagedRequest({
      database,
      settings: createTestSettings(),
      identity,
      user: { id: 'user-1' },
      set: {},
      maxCostNanoUsd: () => 1n,
      checkAdmission: async () => ({ outcome: 'allowed', price }),
    })
    expect(admitted).not.toBeInstanceOf(Response)
    return admitted instanceof Response ? '' : admitted.eventId
  }
  const callbacksFor = (eventId: string, retainHold: typeof retainInferenceHold) =>
    createUsageCallbacks({
      database,
      eventId,
      userId: 'user-1',
      price,
      telemetry: { onUsageMissing: mock(), onUsageError: mock() },
      recordUsage: mock<typeof recordInferenceUsage>(async () => 'inserted'),
      releaseHold: mock<typeof releaseInferenceHold>(async () => {}),
      retainHold,
    })

  it('keeps the hold of a request that ends without usage as its charge, once', async () => {
    const eventId = await admitHeld()
    const retainHold = mock<typeof retainInferenceHold>(async () => {})
    const callbacks = callbacksFor(eventId, retainHold)

    await callbacks.onEnd()
    await callbacks.onEnd()

    expect(retainHold.mock.calls).toEqual([[database, eventId]])
  })

  it('leaves alone a hold that usage settled or a release dropped', async () => {
    const retainHold = mock<typeof retainInferenceHold>(async () => {})
    const settled = callbacksFor(await admitHeld(), retainHold)
    const released = callbacksFor(await admitHeld(), retainHold)

    await settled.onUsage(counts)
    await settled.onEnd()
    await released.release()
    await released.onEnd()

    expect(retainHold).not.toHaveBeenCalled()
  })

  it('releases at shutdown the holds whose request has not ended, and only those', async () => {
    const running = await admitHeld()
    const ended = await admitHeld()
    await callbacksFor(
      ended,
      mock<typeof retainInferenceHold>(async () => {}),
    ).onEnd()
    const releaseHolds = mock<typeof releaseInferenceHolds>(async () => {})

    await releaseOpenHolds(database, releaseHolds)

    const [, released] = releaseHolds.mock.calls[0]
    expect(released).toContain(running)
    expect(released).not.toContain(ended)
  })
})
