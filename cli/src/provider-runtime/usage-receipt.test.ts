/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterAll, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentHarness, AgentHarnessEvent } from '@earendil-works/pi-agent-core'
import type { AssistantMessage } from '@earendil-works/pi-ai'
import { cliVersion } from '../version.ts'
import { readFileOrNull, writeSecureFile } from '../lib/secure-fs.ts'
import { createUsageReceiptLifecycle, submitInferenceUsageReceipt } from './usage-receipt.ts'

const assistantMessage = (
  text: string,
  usage: AssistantMessage['usage'] = {
    input: 11,
    output: 2,
    cacheRead: 3,
    cacheWrite: 2,
    totalTokens: 18,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
): AssistantMessage => ({
  role: 'assistant',
  content: [{ type: 'text', text }],
  api: 'openai-completions',
  provider: 'thunderbolt',
  model: 'glm-5-2',
  usage,
  stopReason: 'stop',
  timestamp: 0,
})

const createHarnessEvents = () => {
  type Listener = Parameters<AgentHarness['subscribe']>[0]
  const listeners = new Set<Listener>()
  const harness: Pick<AgentHarness, 'subscribe'> = {
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
  return {
    harness,
    emit: async (event: AgentHarnessEvent) => {
      for (const listener of listeners) await listener(event)
    },
  }
}

const receiptOutboxDirectory = await mkdtemp(join(tmpdir(), 'thunderbolt-receipt-tests-'))
const testOutboxPath = (): string => join(receiptOutboxDirectory, `${crypto.randomUUID()}.json`)

afterAll(async () => {
  await rm(receiptOutboxDirectory, { recursive: true, force: true })
})

describe('submitInferenceUsageReceipt', () => {
  test('submits exact usage to the authenticated backend receipt endpoint', async () => {
    const requests: Request[] = []

    await submitInferenceUsageReceipt({
      backendUrl: 'https://app.example.com/v1',
      bearer: 'stored-session',
      usage: {
        receipt: 'iu1.canonicalPayload.canonicalSignature',
        promptTokens: 16,
        completionTokens: 2,
        totalTokens: 99,
      },
      fetchFn: async (input, init) => {
        requests.push(new Request(String(input), init))
        return new Response(null, { status: 204 })
      },
    })

    expect(requests).toHaveLength(1)
    expect(requests[0]?.url).toBe('https://app.example.com/v1/inference-usage/receipts')
    expect(requests[0]?.headers.get('authorization')).toBe('Bearer stored-session')
    expect(requests[0]?.headers.get('x-app-version')).toBe(cliVersion)
    expect(requests[0]?.headers.get('x-api-key')).toBeNull()
    expect(await requests[0]?.json()).toEqual({
      receipt: 'iu1.canonicalPayload.canonicalSignature',
      promptTokens: 16,
      completionTokens: 2,
      totalTokens: 99,
    })
  })

  test('aborts a hanging receipt attempt at its deadline', async () => {
    let signal: AbortSignal | undefined
    const submission = submitInferenceUsageReceipt({
      backendUrl: 'https://app.example.com/v1',
      bearer: 'stored-session',
      usage: {
        receipt: 'iu1.canonicalPayload.canonicalSignature',
        promptTokens: 16,
        completionTokens: 2,
        totalTokens: 18,
      },
      timeoutMs: 1,
      fetchFn: async (_input, init) => {
        signal = init?.signal ?? undefined
        return await new Promise<Response>((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(signal?.reason))
        })
      },
    })

    await expect(submission).rejects.toMatchObject({ name: 'TimeoutError' })
    expect(signal?.aborted).toBeTrue()
  })

  test('bounds a stalled unauthorized observer with the request deadline', async () => {
    const reported: Error[] = []
    let requests = 0
    let unauthorizedCalls = 0
    const submission = submitInferenceUsageReceipt({
      backendUrl: 'https://app.example.com/v1',
      bearer: 'stored-session',
      usage: {
        receipt: 'iu1.canonicalPayload.canonicalSignature',
        promptTokens: 16,
        completionTokens: 2,
        totalTokens: 18,
      },
      timeoutMs: 1,
      onUnauthorized: async () => {
        unauthorizedCalls += 1
        return new Promise<void>(() => {})
      },
      reportError: (error) => {
        reported.push(error)
      },
      fetchFn: async () => {
        requests += 1
        return new Response(null, { status: 401 })
      },
    })

    await expect(submission).rejects.toThrow('HTTP 401')
    expect(requests).toBe(1)
    expect(unauthorizedCalls).toBe(1)
    expect(reported).toHaveLength(1)
    expect(reported[0]).toMatchObject({ name: 'TimeoutError' })
  })

  test.each([
    [401, 1],
    [403, 0],
    [429, 0],
    [503, 0],
  ] as const)(
    'reports receipt HTTP %i as unauthorized %i time(s) without replay',
    async (status, expectedUnauthorized) => {
      let requests = 0
      let unauthorized = 0
      const submission = submitInferenceUsageReceipt({
        backendUrl: 'https://app.example.com/v1',
        bearer: 'stored-session',
        usage: {
          receipt: 'iu1.canonicalPayload.canonicalSignature',
          promptTokens: 16,
          completionTokens: 2,
          totalTokens: 18,
        },
        onUnauthorized: async () => {
          unauthorized += 1
        },
        fetchFn: async () => {
          requests += 1
          return new Response(null, { status })
        },
      })

      await expect(submission).rejects.toThrow(`HTTP ${status}`)
      expect(requests).toBe(1)
      expect(unauthorized).toBe(expectedUnauthorized)
    },
  )

  test('preserves a receipt network failure without demoting the session or replaying', async () => {
    const failure = new TypeError('network unavailable')
    let requests = 0
    let unauthorized = 0

    const submission = submitInferenceUsageReceipt({
      backendUrl: 'https://app.example.com/v1',
      bearer: 'stored-session',
      usage: {
        receipt: 'iu1.canonicalPayload.canonicalSignature',
        promptTokens: 16,
        completionTokens: 2,
        totalTokens: 18,
      },
      onUnauthorized: async () => {
        unauthorized += 1
      },
      fetchFn: async () => {
        requests += 1
        throw failure
      },
    })

    await expect(submission).rejects.toBe(failure)
    expect(requests).toBe(1)
    expect(unauthorized).toBe(0)
  })

  test('keeps a known unauthorized response non-retryable when its observer fails', async () => {
    const observerFailure = new Error('auth persistence failed')
    const reported: Error[] = []
    const requests: Request[] = []
    const submission = submitInferenceUsageReceipt({
      backendUrl: 'https://app.example.com/v1',
      bearer: 'stored-session',
      usage: {
        receipt: 'iu1.canonicalPayload.canonicalSignature',
        promptTokens: 16,
        completionTokens: 2,
        totalTokens: 18,
      },
      onUnauthorized: async () => {
        throw observerFailure
      },
      reportError: (error) => {
        reported.push(error)
      },
      fetchFn: async (input, init) => {
        requests.push(new Request(String(input), init))
        return new Response(null, { status: 401 })
      },
    })

    await expect(submission).rejects.toThrow('HTTP 401')
    expect(requests).toHaveLength(1)
    expect(reported).toEqual([observerFailure])
  })
})

describe('createUsageReceiptLifecycle', () => {
  test('retries a failed receipt with backoff before retaining it in the durable outbox', async () => {
    const outboxPath = testOutboxPath()
    const attempts: string[] = []
    const delays: number[] = []
    const lifecycle = await createUsageReceiptLifecycle({
      submit: async (usage) => {
        attempts.push(usage.receipt)
        throw new Error('temporarily unavailable')
      },
      outboxPath,
      wait: async (milliseconds) => {
        delays.push(milliseconds)
      },
    })
    const events = createHarnessEvents()
    lifecycle.attach(events.harness)
    const message = assistantMessage('answer survives retry exhaustion')

    lifecycle.completeProviderStep({ receipt: 'retry-receipt', message })
    await events.emit({ type: 'message_end', message })

    expect(attempts).toEqual(['retry-receipt', 'retry-receipt', 'retry-receipt'])
    expect(delays).toEqual([100, 500])
    expect(JSON.parse(await readFile(outboxPath, 'utf8'))).toEqual([
      { receipt: 'retry-receipt', promptTokens: 16, completionTokens: 2, totalTokens: 18 },
    ])
  })

  test('flushes a durable receipt outbox when the next lifecycle starts', async () => {
    const outboxPath = testOutboxPath()
    const usage = { receipt: 'persisted-receipt', promptTokens: 16, completionTokens: 2, totalTokens: 18 }
    await writeSecureFile(outboxPath, `${JSON.stringify([usage])}\n`)
    const submissions: typeof usage[] = []

    await createUsageReceiptLifecycle({
      submit: async (pending) => {
        submissions.push(pending)
      },
      outboxPath,
      wait: async () => {},
    })

    expect(submissions).toEqual([usage])
    expect(await readFileOrNull(outboxPath)).toBeNull()
  })

  test('reports an outbox persistence failure without rejecting the completed message event', async () => {
    const parentPath = join(receiptOutboxDirectory, crypto.randomUUID())
    const outboxPath = join(parentPath, 'outbox.json')
    await mkdir(parentPath)
    const reported: Error[] = []
    const lifecycle = await createUsageReceiptLifecycle({
      outboxPath,
      reportError: (error) => {
        reported.push(error)
      },
      submit: async () => {},
    })
    await rm(parentPath, { recursive: true })
    await writeFile(parentPath, 'not a directory')
    const events = createHarnessEvents()
    lifecycle.attach(events.harness)
    const message = assistantMessage('answer survives outbox failure')

    lifecycle.completeProviderStep({ receipt: 'unpersisted-receipt', message })
    await expect(events.emit({ type: 'message_end', message })).resolves.toBeUndefined()

    expect(reported).toHaveLength(1)
    expect(reported[0]?.message).toContain('not a directory')
  })

  test('consumes a completed provider step only at its exact assistant message_end', async () => {
    const submissions: Array<{
      readonly receipt: string
      readonly promptTokens: number
      readonly completionTokens: number
      readonly totalTokens: number
    }> = []
    const lifecycle = await createUsageReceiptLifecycle({
      outboxPath: testOutboxPath(),
      wait: async () => {},
      submit: async (usage) => {
        submissions.push(usage)
      },
    })
    const events = createHarnessEvents()
    lifecycle.attach(events.harness)
    const message = assistantMessage('private answer', {
      input: 11,
      output: 2,
      cacheRead: 3,
      cacheWrite: 2,
      totalTokens: 99,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    })

    lifecycle.completeProviderStep({
      receipt: 'iu1.canonicalPayload.canonicalSignature',
      message,
    })
    await events.emit({ type: 'message_end', message })

    expect(submissions).toEqual([
      {
        receipt: 'iu1.canonicalPayload.canonicalSignature',
        promptTokens: 16,
        completionTokens: 2,
        totalTokens: 99,
      },
    ])
  })

  test('clears an unconsumed provider receipt when the harness run ends', async () => {
    const submissions: string[] = []
    const lifecycle = await createUsageReceiptLifecycle({
      outboxPath: testOutboxPath(),
      submit: async (usage) => {
        submissions.push(usage.receipt)
      },
    })
    const events = createHarnessEvents()
    lifecycle.attach(events.harness)
    const message = assistantMessage('orphaned answer')
    lifecycle.completeProviderStep({ receipt: 'stale-receipt', message })

    await events.emit({ type: 'agent_end', messages: [] })
    await events.emit({ type: 'message_end', message })

    expect(submissions).toEqual([])
  })

  test('isolates submission failure and still accepts the next completed step', async () => {
    const attempts: string[] = []
    const lifecycle = await createUsageReceiptLifecycle({
      outboxPath: testOutboxPath(),
      wait: async () => {},
      submit: async (usage) => {
        attempts.push(usage.receipt)
        if (usage.receipt === 'failed-receipt') throw new Error('receipt backend unavailable')
      },
    })
    const events = createHarnessEvents()
    lifecycle.attach(events.harness)
    const failedMessage = assistantMessage('answer survives accounting failure')
    const nextMessage = assistantMessage('next answer')

    lifecycle.completeProviderStep({ receipt: 'failed-receipt', message: failedMessage })
    await expect(events.emit({ type: 'message_end', message: failedMessage })).resolves.toBeUndefined()
    lifecycle.completeProviderStep({ receipt: 'next-receipt', message: nextMessage })
    await events.emit({ type: 'message_end', message: nextMessage })

    expect(attempts).toEqual([
      'failed-receipt',
      'failed-receipt',
      'failed-receipt',
      'failed-receipt',
      'failed-receipt',
      'failed-receipt',
      'next-receipt',
    ])
  })

  test('clears pending state on abort before a terminal message arrives', async () => {
    const submissions: string[] = []
    const lifecycle = await createUsageReceiptLifecycle({
      outboxPath: testOutboxPath(),
      submit: async (usage) => {
        submissions.push(usage.receipt)
      },
    })
    const events = createHarnessEvents()
    lifecycle.attach(events.harness)
    const message = assistantMessage('aborted answer')
    lifecycle.completeProviderStep({ receipt: 'aborted-receipt', message })

    await events.emit({ type: 'abort', clearedSteer: [], clearedFollowUp: [] })
    await events.emit({ type: 'message_end', message })

    expect(submissions).toEqual([])
  })

  test('unsubscribe is idempotent and clears pending state', async () => {
    const submissions: string[] = []
    const lifecycle = await createUsageReceiptLifecycle({
      outboxPath: testOutboxPath(),
      submit: async (usage) => {
        submissions.push(usage.receipt)
      },
    })
    const events = createHarnessEvents()
    const unsubscribe = lifecycle.attach(events.harness)
    const message = assistantMessage('detached answer')
    lifecycle.completeProviderStep({ receipt: 'detached-receipt', message })

    unsubscribe()
    unsubscribe()
    await events.emit({ type: 'message_end', message })

    expect(submissions).toEqual([])
  })
})
