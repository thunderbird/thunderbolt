/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { createAuthenticatedClient } from '@/lib/http'
import { getClock } from '@/testing-library'
import type { Model } from '@/types'
import { managedGlmIdentity } from '@shared/inference-usage'
import { submitGlmStepUsageReceipt, type ReceiptStep } from './inference-usage-receipt'

const receipt = 'iu1.canonicalPayload.canonicalSignature'
const systemGlm = { ...managedGlmIdentity, isSystem: 1 } satisfies Pick<Model, 'provider' | 'model' | 'isSystem'>

const createStep = ({
  headers = { 'x-inference-usage-receipt': receipt },
  usage = { inputTokens: 16, outputTokens: 2, totalTokens: 18 },
}: {
  headers?: ReceiptStep['response']['headers']
  usage?: ReceiptStep['usage']
} = {}): ReceiptStep => ({ response: { headers }, usage })

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

describe('submitGlmStepUsageReceipt', () => {
  it('submits the lower-case AI SDK response header and exact final step usage through the authenticated client', async () => {
    const { httpClient, requests } = createCapturingClient()

    await submitGlmStepUsageReceipt({ model: systemGlm, step: createStep(), httpClient })

    expect(requests).toHaveLength(1)
    expect(requests[0].url).toBe('https://app.example.com/v1/inference-usage/receipts')
    expect(requests[0].headers.get('authorization')).toBe('Bearer session-token')
    expect(await requests[0].json()).toEqual({
      receipt,
      promptTokens: 16,
      completionTokens: 2,
      totalTokens: 18,
    })
  })

  it('accepts a safe-integer total that does not equal prompt plus completion', async () => {
    const { httpClient, requests } = createCapturingClient()

    await submitGlmStepUsageReceipt({
      model: systemGlm,
      step: createStep({ usage: { inputTokens: 16, outputTokens: 2, totalTokens: 99 } }),
      httpClient,
    })

    expect(await requests[0].json()).toEqual({
      receipt,
      promptTokens: 16,
      completionTokens: 2,
      totalTokens: 99,
    })
  })

  it('accepts JavaScript safe integers above the backend persistence limit', async () => {
    const { httpClient, requests } = createCapturingClient()

    await submitGlmStepUsageReceipt({
      model: systemGlm,
      step: createStep({
        usage: {
          inputTokens: Number.MAX_SAFE_INTEGER,
          outputTokens: 0,
          totalTokens: Number.MAX_SAFE_INTEGER,
        },
      }),
      httpClient,
    })

    expect(requests).toHaveLength(1)
  })

  it.each([
    ['missing header', createStep({ headers: {} })],
    ['empty header', createStep({ headers: { 'x-inference-usage-receipt': '' } })],
    [
      'canonical-case key instead of normalized lower-case',
      createStep({ headers: { 'X-Inference-Usage-Receipt': receipt } }),
    ],
    ['missing input', createStep({ usage: { outputTokens: 2, totalTokens: 18 } })],
    ['missing output', createStep({ usage: { inputTokens: 16, totalTokens: 18 } })],
    ['missing total', createStep({ usage: { inputTokens: 16, outputTokens: 2 } })],
    ['negative input', createStep({ usage: { inputTokens: -1, outputTokens: 2, totalTokens: 18 } })],
    ['fractional output', createStep({ usage: { inputTokens: 16, outputTokens: 2.5, totalTokens: 18 } })],
    [
      'unsafe total',
      createStep({ usage: { inputTokens: 16, outputTokens: 2, totalTokens: Number.MAX_SAFE_INTEGER + 1 } }),
    ],
    ['NaN input', createStep({ usage: { inputTokens: Number.NaN, outputTokens: 2, totalTokens: 18 } })],
    [
      'infinite output',
      createStep({ usage: { inputTokens: 16, outputTokens: Number.POSITIVE_INFINITY, totalTokens: 18 } }),
    ],
  ] as const)('skips %s without an HTTP request', async (_name, step) => {
    const { httpClient, requests } = createCapturingClient()

    await submitGlmStepUsageReceipt({ model: systemGlm, step, httpClient })

    expect(requests).toHaveLength(0)
  })

  it.each([
    { provider: 'tinfoil', model: 'glm-5-2', isSystem: 0 },
    { provider: 'tinfoil', model: 'glm-5-2', isSystem: null },
    { provider: 'tinfoil', model: 'glm-4', isSystem: 1 },
    { provider: 'thunderbolt', model: 'deepseek-v4-flash', isSystem: 1 },
    { provider: 'thunderbolt', model: 'opus-5', isSystem: 1 },
    { provider: 'anthropic', model: 'claude-opus-5', isSystem: 1 },
    { provider: 'openai', model: 'glm-5-2', isSystem: 1 },
    { provider: 'custom', model: 'glm-5-2', isSystem: 1 },
  ] satisfies Array<Pick<Model, 'provider' | 'model' | 'isSystem'>>)('skips non-managed model %o', async (model) => {
    const { httpClient, requests } = createCapturingClient()

    await submitGlmStepUsageReceipt({ model, step: createStep(), httpClient })

    expect(requests).toHaveLength(0)
  })

  it('awaits the HTTP attempt before settling', async () => {
    let resolveResponse: ((response: Response) => void) | undefined
    const response = new Promise<Response>((resolve) => {
      resolveResponse = resolve
    })
    const { httpClient } = createCapturingClient(async () => response)
    let settled = false

    const submission = submitGlmStepUsageReceipt({ model: systemGlm, step: createStep(), httpClient }).finally(() => {
      settled = true
    })
    await Promise.resolve()
    await Promise.resolve()

    expect(settled).toBeFalse()
    resolveResponse?.(new Response(null, { status: 204 }))
    await expect(submission).resolves.toBeUndefined()
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

    const submission = submitGlmStepUsageReceipt({ model: systemGlm, step: createStep(), httpClient })
    let rejectionName: string | undefined
    const handledSubmission = submission.catch((error: Error) => {
      rejectionName = error.name
    })
    await Promise.resolve()
    await Promise.resolve()

    expect(receiptSignal?.aborted).toBeFalse()
    await getClock().tickAsync(2_999)
    expect(receiptSignal?.aborted).toBeFalse()
    await getClock().tickAsync(1)
    expect(receiptSignal?.aborted).toBeTrue()
    await handledSubmission
    expect(rejectionName).toBe('TimeoutError')
  })

  it('surfaces an HTTP status failure for the onStepFinish boundary to isolate', async () => {
    const { httpClient } = createCapturingClient(async () => new Response(null, { status: 503 }))

    await expect(submitGlmStepUsageReceipt({ model: systemGlm, step: createStep(), httpClient })).rejects.toThrow(
      'Request failed with status 503',
    )
  })
})
