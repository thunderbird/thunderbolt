/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { createAuthenticatedClient } from '@/lib/http'
import { getClock } from '@/testing-library'
import type { InferenceUsageReceiptRequest } from '@shared/inference-usage'
import { submitInferenceUsageReceipt } from './inference-usage-receipt'

const usage: InferenceUsageReceiptRequest = {
  receipt: 'iu1.canonicalPayload.canonicalSignature',
  promptTokens: 16,
  completionTokens: 2,
  totalTokens: 18,
}

const createCapturingClient = (
  respond: (request: Request) => Promise<Response> = async () => new Response(null, { status: 204 }),
) => {
  const requests: Request[] = []
  const httpClient = createAuthenticatedClient('https://app.example.com/v1/', () => 'session-token', {
    fetch: async (input) => {
      const request = input as Request
      requests.push(request)
      return respond(request)
    },
  })
  return { httpClient, requests }
}

describe('submitInferenceUsageReceipt', () => {
  it('posts the shared request shape through the authenticated client', async () => {
    const { httpClient, requests } = createCapturingClient()

    await submitInferenceUsageReceipt(usage, httpClient)

    expect(requests).toHaveLength(1)
    expect(requests[0].url).toBe('https://app.example.com/v1/inference-usage/receipts')
    expect(requests[0].headers.get('authorization')).toBe('Bearer session-token')
    expect(await requests[0].json()).toEqual(usage)
  })

  it('aborts a hanging receipt POST after three seconds', async () => {
    let receiptSignal: AbortSignal | undefined
    const { httpClient } = createCapturingClient(
      async (request) =>
        new Promise<Response>((_resolve, reject) => {
          receiptSignal = request.signal
          request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true })
        }),
    )

    const handledSubmission = (async () => {
      try {
        await submitInferenceUsageReceipt(usage, httpClient)
        return 'resolved'
      } catch (error) {
        return (error as Error).name
      }
    })()
    await Promise.resolve()
    await Promise.resolve()

    expect(receiptSignal?.aborted).toBeFalse()
    await getClock().tickAsync(3_000)
    expect(receiptSignal?.aborted).toBeTrue()
    await expect(handledSubmission).resolves.toBe('TimeoutError')
  })

  it('surfaces an HTTP status failure for the shared lifecycle to isolate', async () => {
    const { httpClient } = createCapturingClient(async () => new Response(null, { status: 503 }))

    await expect(submitInferenceUsageReceipt(usage, httpClient)).rejects.toThrow('Request failed with status 503')
  })
})
