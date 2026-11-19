/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, mock, spyOn, test } from 'bun:test'
import { createModels } from '@earendil-works/pi-ai'
import { AttestationError } from '@tinfoilsh/verifier'
import { SecureClient } from 'tinfoil'
import { defaultModelGlm53, defaultModelDeepSeekV41Flash, type SharedModel } from '../../../shared/defaults/models.ts'
import { inferenceModelHeader } from '../../../shared/inference-usage.ts'
import { noReasoningEffort, type ReasoningCapabilities } from '../../../shared/reasoning-effort.ts'
import { parseTinfoilReasoningCatalog } from '../../../shared/reasoning-effort-catalog.ts'
import { createHarnessRuntime } from '../agent/harness.ts'
import type { ThinkingLevel } from '../agent/types.ts'
import { cliVersion } from '../version.ts'
import type { HarnessRuntime, PreparedPiBinding, ResolvedAccountCredential } from './types.ts'
import { createTestProviderRuntime, testSessionCredential } from './test-fixtures.ts'
import { createTinfoilBinding, type CreateTinfoilBindingOptions } from './tinfoil.ts'
import { prepareProviderBinding } from './provider-stage.ts'
import { runProviderManager } from './manager.ts'

const confidentialModel: SharedModel = {
  ...defaultModelGlm53,
  name: 'GLM 5.2',
  description: 'Confidential GLM',
  vendor: 'zai',
  contextWindow: 128_000,
  startWithReasoning: 1,
  supportsParallelToolCalls: 1,
}

// Representative metadata captured from Tinfoil's public /v1/models endpoint on 2026-11-05.
const reasoningCatalog = parseTinfoilReasoningCatalog({
  data: [
    { id: 'glm-5-3', reasoning: true, supported_efforts: ['low', 'high', 'max'] },
    { id: 'deepseek-v4-1-flash', reasoning: true, supported_efforts: ['none', 'low', 'high', 'xhigh', 'max'] },
  ],
})

const sessionCredential = (
  overrides: Partial<Extract<ResolvedAccountCredential, { type: 'session' }>> = {},
): Extract<ResolvedAccountCredential, { type: 'session' }> => ({
  ...testSessionCredential({
    backendUrl: 'https://app.example.com/v1',
    userCacheSecret: new Uint8Array(32).fill(0xab),
  }),
  ...overrides,
})

const bindingOptions = (
  credential: Extract<ResolvedAccountCredential, { type: 'session' }> = sessionCredential(),
): CreateTinfoilBindingOptions => ({
  credential,
  model: confidentialModel,
  supportsImages: false,
  onStoredSessionRejected: async () => {},
  loadReasoningCapabilities: async (modelId) => reasoningCatalog.get(modelId) ?? noReasoningEffort,
})

const successfulCompletion = (): Response =>
  new Response(
    [
      `data: ${JSON.stringify({
        id: 'chatcmpl-private',
        object: 'chat.completion.chunk',
        created: 1,
        model: confidentialModel.model,
        choices: [
          { index: 0, delta: { role: 'assistant', reasoning_content: 'private reasoning' }, finish_reason: null },
        ],
      })}`,
      `data: ${JSON.stringify({
        id: 'chatcmpl-private',
        object: 'chat.completion.chunk',
        created: 1,
        model: confidentialModel.model,
        choices: [{ index: 0, delta: { role: 'assistant', content: 'private answer' }, finish_reason: null }],
      })}`,
      `data: ${JSON.stringify({
        id: 'chatcmpl-private',
        object: 'chat.completion.chunk',
        created: 1,
        model: confidentialModel.model,
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        usage: {
          prompt_tokens: 16,
          completion_tokens: 2,
          total_tokens: 18,
          prompt_tokens_details: { cached_tokens: 3, cache_write_tokens: 2 },
        },
      })}`,
      'data: [DONE]',
      '',
    ].join('\n\n'),
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  )

const hangingCompletion = (request: Request): Response =>
  new Response(
    new ReadableStream<Uint8Array>({
      start: (controller) => {
        const abort = () => controller.error(request.signal.reason ?? new DOMException('Aborted', 'AbortError'))
        if (request.signal.aborted) {
          abort()
          return
        }
        request.signal.addEventListener('abort', abort, { once: true })
      },
    }),
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  )

/** Injects a deterministic secure transport without patching the SDK prototype. */
const secureClientFactory =
  (
    respond: (request: Request) => Promise<Response> | Response,
    reset: () => void = () => {},
    observedOptions?: ConstructorParameters<typeof SecureClient>[0][],
  ): NonNullable<CreateTinfoilBindingOptions['createSecureClient']> =>
  (options) => {
    observedOptions?.push(options)
    const client = Object.create(SecureClient.prototype) as SecureClient
    Object.defineProperties(client, {
      fetch: {
        value: Object.assign(
          async (input: Parameters<typeof fetch>[0], init?: RequestInit) => respond(new Request(String(input), init)),
          { preconnect: () => {} },
        ),
      },
      reset: { value: reset },
    })
    return client
  }

/** Build the production AgentHarness runtime around one Tinfoil binding. */
const createRuntime = (binding: PreparedPiBinding, thinking: ThinkingLevel = 'high'): Promise<HarnessRuntime> =>
  createHarnessRuntime(
    {
      cwd: process.cwd(),
      thinking,
    },
    binding,
  )

describe('createTinfoilBinding', () => {
  test('cancels hanging discovery and disposes the binding created after caller cancellation', async () => {
    const controller = new AbortController()
    const discoveryStarted = Promise.withResolvers<void>()
    const pendingDiscovery = Promise.withResolvers<ReasoningCapabilities>()
    const disposed = Promise.withResolvers<void>()
    const reset = mock(() => disposed.resolve())
    const warn = spyOn(console, 'warn').mockImplementation(() => {})
    const { runtime } = await createTestProviderRuntime({
      resolveAccountCredential: async () => sessionCredential(),
      loadCatalog: async () => ({
        version: 1,
        defaultModelId: confidentialModel.id,
        data: [confidentialModel],
        imageSupport: {},
      }),
      createTinfoilBinding: (options) =>
        createTinfoilBinding({
          ...bindingOptions(),
          ...options,
          loadReasoningCapabilities: async () => {
            discoveryStarted.resolve()
            return pendingDiscovery.promise
          },
          createSecureClient: secureClientFactory(() => successfulCompletion(), reset),
        }),
    })
    try {
      const pending = prepareProviderBinding(
        runtime,
        { providerId: 'thunderbolt', model: confidentialModel.id },
        { signal: controller.signal },
      )
      await discoveryStarted.promise
      controller.abort()
      await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
      await disposed.promise
      expect(reset).toHaveBeenCalledTimes(1)
    } finally {
      pendingDiscovery.resolve(noReasoningEffort)
      warn.mockRestore()
    }
  })

  test.each(['before discovery starts', 'while discovery is pending'] as const)(
    'prepares and runs a manager-selected model when the advisory deadline expires %s',
    async (expiry) => {
      const pending = Promise.withResolvers<ReasoningCapabilities>()
      const discoveryStarted = Promise.withResolvers<void>()
      const requiredStarted = Promise.withResolvers<void>()
      const requiredReady = Promise.withResolvers<void>()
      const overallDeadline = new AbortController()
      const advisoryDeadline = new AbortController()
      const loadReasoningCapabilities = mock(async () => {
        discoveryStarted.resolve()
        return pending.promise
      })
      const warn = spyOn(console, 'warn').mockImplementation(() => {})
      const catalog = { version: 1, defaultModelId: confidentialModel.id, data: [confidentialModel], imageSupport: {} }
      const loadCatalog = mock(async () => catalog)
      const { runtime: providerRuntime } = await createTestProviderRuntime({
        loadConfig: async () => ({
          version: 3,
          activeProviderId: 'thunderbolt',
          thunderbolt: { defaultModelId: confidentialModel.id },
          providers: [],
        }),
        resolveAccountCredential: async () => sessionCredential(),
        loadCatalog,
        createTinfoilBinding: (options) =>
          createTinfoilBinding({
            ...bindingOptions(),
            ...options,
            loadReasoningCapabilities,
            createSecureClient: secureClientFactory(() => successfulCompletion()),
          }),
      })
      try {
        const outcome = await runProviderManager(
          {
            choose: async () => confidentialModel.id,
            readText: async () => null,
            readSecret: async () => null,
            write: () => {},
            showVerification: () => {},
            showStatus: () => {},
          },
          providerRuntime,
          'models',
        )
        if (outcome.kind !== 'switch') throw new Error('Expected the model manager to select a binding')
        loadCatalog.mockImplementation(async () => {
          requiredStarted.resolve()
          await requiredReady.promise
          return catalog
        })
        const timeout = spyOn(AbortSignal, 'timeout')
          .mockReturnValueOnce(overallDeadline.signal)
          .mockReturnValueOnce(advisoryDeadline.signal)
        const preparation = prepareProviderBinding(providerRuntime, outcome.selection, { timeoutMs: 500 })
        let runtime: HarnessRuntime | undefined
        try {
          await requiredStarted.promise
          expect(timeout).toHaveBeenNthCalledWith(1, 500)
          expect(timeout).toHaveBeenNthCalledWith(2, 250)
          expect(timeout).toHaveBeenCalledTimes(2)
          if (expiry === 'while discovery is pending') {
            requiredReady.resolve()
            await discoveryStarted.promise
          }
          advisoryDeadline.abort(new DOMException('Advisory deadline expired', 'TimeoutError'))
          requiredReady.resolve()
          const binding = await preparation
          timeout.mockRestore()
          runtime = await createRuntime(binding, 'medium')
          expect(runtime.reasoning.capabilities()).toEqual(noReasoningEffort)
          expect((await runtime.prompt('Continue working')).stopReason).toBe('stop')
          expect(loadReasoningCapabilities).toHaveBeenCalledTimes(expiry === 'while discovery is pending' ? 1 : 0)
        } finally {
          requiredReady.resolve()
          pending.resolve(noReasoningEffort)
          try {
            const [result] = await Promise.allSettled([preparation])
            if (runtime) await runtime.dispose()
            else if (result.status === 'fulfilled') await result.value.dispose()
          } finally {
            timeout.mockRestore()
          }
        }
      } finally {
        warn.mockRestore()
      }
    },
  )

  test('keeps ordinary inference working through legacy defaults during a cold discovery outage', async () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {})
    const requests: Record<string, unknown>[] = []
    const binding = await createTinfoilBinding({
      ...bindingOptions(),
      loadReasoningCapabilities: async () => {
        throw new Error('Catalog unavailable')
      },
      createSecureClient: secureClientFactory(async (request) => {
        requests.push((await request.json()) as Record<string, unknown>)
        return successfulCompletion()
      }),
    })
    const runtime = await createRuntime(binding, 'medium')
    try {
      expect(runtime.reasoning.capabilities()).toEqual({ efforts: [] })
      await expect(runtime.reasoning.set('high')).rejects.toThrow('Unsupported reasoning effort')
      expect((await runtime.prompt('Continue working')).stopReason).toBe('stop')
      // GLM does not accept native medium. Preserve Pi's medium -> high compatibility mapping.
      expect(requests[0]?.reasoning_effort).toBe('high')
      expect(warn).toHaveBeenCalledTimes(1)
    } finally {
      await runtime.dispose()
      warn.mockRestore()
    }
  })

  test.each([noReasoningEffort, { efforts: ['none', 'max'] as const }])(
    'uses discovered capabilities even when they differ from the bundled model (%j)',
    async (capabilities) => {
      const binding = await createTinfoilBinding({
        ...bindingOptions(),
        loadReasoningCapabilities: async () => capabilities,
        createSecureClient: secureClientFactory(() => successfulCompletion()),
      })
      const runtime = await createRuntime(binding)
      try {
        expect(runtime.reasoning.capabilities()).toEqual(capabilities)
        expect(binding.piModel.reasoning).toBe(true)
        await expect(runtime.reasoning.set('high')).rejects.toThrow('Unsupported reasoning effort')
        for (const effort of capabilities.efforts) {
          await runtime.reasoning.set(effort)
          expect(runtime.reasoning.current()).toBe(effort)
        }
      } finally {
        await runtime.dispose()
      }
    },
  )

  test('rejects a cache secret that is not exactly 32 bytes before binding construction', async () => {
    await expect(
      createTinfoilBinding(bindingOptions(sessionCredential({ userCacheSecret: new Uint8Array(31) }))),
    ).rejects.toMatchObject({
      code: 'config-invalid',
    })
  })

  test('rejects a non-byte cache secret even when it claims the expected length', async () => {
    await expect(
      createTinfoilBinding({
        ...bindingOptions(),
        credential: {
          ...sessionCredential(),
          // @ts-expect-error Exercise validation after an untyped runtime bypasses the frozen seam.
          userCacheSecret: { byteLength: 32 },
        },
      }),
    ).rejects.toMatchObject({ code: 'config-invalid' })
  })

  test('maps missing Pi compatibility metadata to the CLI config error contract', async () => {
    await expect(
      createTinfoilBinding({
        ...bindingOptions(),
        model: { ...confidentialModel, model: 'unknown-model', vendor: 'unknown' },
        createSecureClient: () => {
          throw new Error('SecureClient must not be constructed for invalid model metadata.')
        },
      }),
    ).rejects.toMatchObject({
      code: 'config-invalid',
      message: 'Managed model "unknown-model" has no Pi compatibility metadata.',
    })
  })

  test('preserves a real Tinfoil stream attestation failure instead of Pi Connection error', async () => {
    let readyCalls = 0
    const rejected: string[] = []
    const createSecureClient = secureClientFactory(() => {
      readyCalls += 1
      throw new AttestationError('TLS measurement mismatch: sk-live-secret')
    })
    const binding = await createTinfoilBinding({
      ...bindingOptions(),
      onStoredSessionRejected: async () => {
        rejected.push('session')
      },
      createSecureClient,
    })
    const runtime = await createRuntime(binding)
    try {
      const message = await runtime.prompt('private request')

      expect(message).toMatchObject({
        stopReason: 'error',
        errorMessage: 'Confidential model attestation failed.',
      })
      expect(message.errorMessage).not.toContain('Connection error')
      expect(JSON.stringify(message)).not.toContain('sk-live-secret')
      expect(readyCalls).toBe(1)
      expect(rejected).toEqual([])
    } finally {
      await runtime.dispose()
    }
  })

  test('builds a confidential Thunderbolt Pi binding and resets its SecureClient once', async () => {
    let resets = 0
    const clientOptions: ConstructorParameters<typeof SecureClient>[0][] = []
    const binding = await createTinfoilBinding({
      ...bindingOptions(),
      createSecureClient: secureClientFactory(
        () => successfulCompletion(),
        () => {
          resets += 1
        },
        clientOptions,
      ),
    })
    const models = createModels()
    binding.install(models)

    expect(binding).toMatchObject({
      providerId: 'thunderbolt',
      wireModel: 'glm-5-3',
      persistsCredentialStatus: false,
    })
    expect(binding.piModel).toMatchObject({
      id: 'glm-5-3',
      provider: 'thunderbolt',
      reasoning: true,
      contextWindow: 128_000,
      input: ['text'],
    })
    expect(models.getProvider('thunderbolt')).toBeDefined()
    expect(clientOptions).toEqual([
      {
        baseURL: 'https://app.example.com/v1/tinfoil',
        userCacheSecret: 'ab'.repeat(32),
      },
    ])

    await binding.dispose()
    await binding.dispose()
    expect(resets).toBe(1)
  })

  test.each([
    ['glm-5-3', 'off', undefined, 'low'],
    ['glm-5-3', 'minimal', undefined, 'low'],
    ['glm-5-3', 'medium', undefined, 'high'],
    ['glm-5-2', 'low', { type: 'enabled', clear_thinking: false }, 'high'],
  ] as const)(
    'maps %s %s thinking through Pi compatibility',
    async (modelId, level, expectedThinking, expectedEffort) => {
      let requestThinking: unknown
      let requestEffort: unknown
      const createSecureClient = secureClientFactory(async (request) => {
        const payload = (await request.json()) as {
          readonly thinking?: unknown
          readonly reasoning_effort?: unknown
        }
        expect(payload).toMatchObject({ model: modelId })
        requestThinking = payload.thinking
        requestEffort = payload.reasoning_effort
        return successfulCompletion()
      })
      const binding = await createTinfoilBinding({
        ...bindingOptions(),
        model: { ...confidentialModel, model: modelId },
        createSecureClient,
      })
      const runtime = await createRuntime(binding, level)
      try {
        await runtime.prompt(crypto.randomUUID())

        expect(requestThinking).toEqual(expectedThinking)
        expect(requestEffort).toBe(expectedEffort)
      } finally {
        await runtime.dispose()
      }
    },
  )

  test.each([defaultModelGlm53, defaultModelDeepSeekV41Flash])(
    'advertises and sends every native effort unchanged for $model',
    async (model) => {
      const requests: Record<string, unknown>[] = []
      const binding = await createTinfoilBinding({
        ...bindingOptions(),
        model,
        createSecureClient: secureClientFactory(async (request) => {
          requests.push((await request.json()) as Record<string, unknown>)
          return successfulCompletion()
        }),
      })
      const runtime = await createRuntime(binding)
      const capabilities = reasoningCatalog.get(model.model)!
      try {
        expect(runtime.reasoning.capabilities()).toEqual(capabilities)
        for (const effort of capabilities.efforts) {
          await runtime.reasoning.set(effort)
          expect(runtime.reasoning.current()).toBe(effort)
          await runtime.prompt(`Use ${effort}`)
          const payload = requests.at(-1)!
          expect(payload.reasoning_effort).toBe(effort)
          expect(payload.thinking).toBeUndefined()
          expect(payload.chat_template_kwargs).toBeUndefined()
        }
      } finally {
        await runtime.dispose()
      }
    },
  )

  test('keeps exact effort controls attached to the current binding across a model switch', async () => {
    const requests: Record<string, unknown>[] = []
    const createSecureClient = secureClientFactory(async (request) => {
      requests.push((await request.json()) as Record<string, unknown>)
      return successfulCompletion()
    })
    const glm = await createTinfoilBinding({ ...bindingOptions(), createSecureClient })
    const runtime = await createRuntime(glm)
    try {
      await runtime.reasoning.set('max')
      await runtime.prompt('GLM maximum')
      const deepseek = await createTinfoilBinding({
        ...bindingOptions(),
        model: defaultModelDeepSeekV41Flash,
        createSecureClient,
      })
      await runtime.switchBinding(
        deepseek,
        { commit: async () => {}, rollback: async () => {}, finalize: async () => {} },
        { forceReplace: false },
      )
      expect(runtime.reasoning.current()).toBe('max')
      await runtime.prompt('DeepSeek maximum')
      await runtime.reasoning.set('none')
      await runtime.prompt('DeepSeek off')
      expect(requests.map(({ model, reasoning_effort }) => [model, reasoning_effort])).toEqual([
        ['glm-5-3', 'max'],
        ['deepseek-v4-1-flash', 'max'],
        ['deepseek-v4-1-flash', 'none'],
      ])
    } finally {
      await runtime.dispose()
    }
  })

  test('derives thinking semantics from each confidential model instead of GLM 5.2', async () => {
    const requestEfforts: unknown[] = []
    const model = { ...confidentialModel, model: 'glm-4.7', vendor: 'zhipu' }
    const binding = await createTinfoilBinding({
      ...bindingOptions(),
      model,
      createSecureClient: secureClientFactory(async (request) => {
        const payload = (await request.json()) as { readonly reasoning_effort?: unknown }
        requestEfforts.push(payload.reasoning_effort)
        return successfulCompletion()
      }),
    })
    const runtime = await createRuntime(binding, 'medium')
    try {
      await runtime.prompt(crypto.randomUUID())

      expect(requestEfforts).toEqual([undefined])
    } finally {
      await runtime.dispose()
    }
  })

  test.each([confidentialModel, defaultModelDeepSeekV41Flash])('sends $model identity', async (model) => {
    const secureRequests: Request[] = []
    const binding = await createTinfoilBinding({
      ...bindingOptions(),
      model,
      createSecureClient: secureClientFactory((request) => {
        secureRequests.push(request)
        return successfulCompletion()
      }),
    })
    const runtime = await createHarnessRuntime(
      {
        cwd: process.cwd(),
        thinking: 'high',
      },
      binding,
    )

    try {
      const message = await runtime.prompt('keep this private')

      expect(message.content).toContainEqual({
        type: 'thinking',
        thinking: 'private reasoning',
        thinkingSignature: 'reasoning_content',
      })
      expect(message.content).toContainEqual({ type: 'text', text: 'private answer' })
      expect(secureRequests).toHaveLength(1)
      expect(secureRequests[0]?.headers.get(inferenceModelHeader)).toBe(model.model)
      expect(secureRequests[0]?.url).toBe('https://app.example.com/v1/tinfoil/chat/completions')
      expect(secureRequests[0]?.headers.get('authorization')).toBe('Bearer stored-session')
      expect(secureRequests[0]?.headers.get('x-app-version')).toBe(cliVersion)
      expect(secureRequests[0]?.headers.get('x-api-key')).toBeNull()
      const requestPayload = (await secureRequests[0]?.json()) as {
        readonly model?: unknown
        readonly stream?: unknown
      }
      expect(requestPayload.model).toBe(model.model)
      expect(requestPayload.stream).toBe(true)
    } finally {
      await runtime.dispose()
    }
  })

  test('rejects a remote plain-HTTP backend before constructing a secure request', async () => {
    await expect(
      createTinfoilBinding(bindingOptions(sessionCredential({ backendUrl: 'http://api.example.test/v1' }))),
    ).rejects.toMatchObject({ code: 'config-invalid' })
  })

  test('allows loopback HTTP and scopes the secure client to the backend tinfoil route', async () => {
    const binding = await createTinfoilBinding(
      bindingOptions(sessionCredential({ backendUrl: 'http://127.0.0.1:8000' })),
    )
    try {
      expect(binding.piModel.baseUrl).toBe('http://127.0.0.1:8000/v1/tinfoil')
    } finally {
      await binding.dispose()
    }
  })

  test.each([401, 403] as const)(
    'marks the stored session rejected once after confidential inference %i',
    async (status) => {
      const rejected: string[] = []
      let inferenceRequests = 0
      const ready = secureClientFactory(() => {
        inferenceRequests += 1
        return Response.json({ error: { message: 'session expired' } }, { status })
      })
      const binding = await createTinfoilBinding({
        ...bindingOptions(),
        createSecureClient: ready,
        onStoredSessionRejected: async () => {
          rejected.push('session')
        },
      })
      const runtime = await createRuntime(binding)
      try {
        const message = await runtime.prompt('private request')
        await binding.observePromptError(message)

        expect(message.stopReason).toBe('error')
        expect(rejected).toEqual(['session'])
        expect(inferenceRequests).toBe(1)
      } finally {
        await runtime.dispose()
      }
    },
  )

  test.each([429, 503] as const)('does not reject the stored session for confidential inference %i', async (status) => {
    const rejected: string[] = []
    const ready = secureClientFactory(() => Response.json({ error: { message: 'temporary failure' } }, { status }))
    const binding = await createTinfoilBinding({
      ...bindingOptions(),
      createSecureClient: ready,
      onStoredSessionRejected: async () => {
        rejected.push('session')
      },
    })
    const runtime = await createRuntime(binding)
    try {
      const message = await runtime.prompt('private request')
      expect(message.stopReason).toBe('error')
      expect(rejected).toEqual([])
    } finally {
      await runtime.dispose()
    }
  })

  test('does not reject the stored session when confidential inference fails before an HTTP response', async () => {
    const rejected: string[] = []
    let inferenceRequests = 0
    const ready = secureClientFactory(() => {
      inferenceRequests += 1
      throw new TypeError('network unavailable')
    })
    const binding = await createTinfoilBinding({
      ...bindingOptions(),
      createSecureClient: ready,
      onStoredSessionRejected: async () => {
        rejected.push('session')
      },
    })
    const runtime = await createRuntime(binding)
    try {
      const message = await runtime.prompt('private request')

      expect(message.stopReason).toBe('error')
      expect(rejected).toEqual([])
      expect(inferenceRequests).toBe(1)
      expect(message).not.toHaveProperty('code')
    } finally {
      await runtime.dispose()
    }
  })

  test('dispose aborts the stream and resets SecureClient idempotently', async () => {
    const responseStarted = Promise.withResolvers<void>()
    let resets = 0
    const ready = secureClientFactory(
      (request) => {
        responseStarted.resolve()
        return hangingCompletion(request)
      },
      () => {
        resets += 1
      },
    )
    const binding = await createTinfoilBinding({
      ...bindingOptions(),
      createSecureClient: ready,
    })
    const runtime = await createRuntime(binding)
    const prompt = runtime.prompt('dispose this private request')
    await responseStarted.promise

    try {
      await Promise.all([runtime.dispose(), runtime.dispose()])
      expect((await prompt).stopReason).toBe('aborted')
      expect(resets).toBe(1)
    } finally {
      await runtime.dispose()
    }
  })

  test('keeps concurrent binding session auth isolated per harness', async () => {
    const observedAuthorization: string[] = []
    const ready = secureClientFactory((request) => {
      observedAuthorization.push(request.headers.get('authorization') ?? '')
      return successfulCompletion()
    })
    const bindingA = await createTinfoilBinding({
      ...bindingOptions(sessionCredential({ bearer: 'session-a' })),
      createSecureClient: ready,
    })
    const bindingB = await createTinfoilBinding({
      ...bindingOptions(sessionCredential({ bearer: 'session-b', userCacheSecret: new Uint8Array(32).fill(0xcd) })),
      createSecureClient: ready,
    })
    const [runtimeA, runtimeB] = await Promise.all([createRuntime(bindingA), createRuntime(bindingB)])
    try {
      const [messageA, messageB] = await Promise.all([runtimeA.prompt('private A'), runtimeB.prompt('private B')])

      expect(messageA.stopReason).toBe('stop')
      expect(messageB.stopReason).toBe('stop')
      expect(observedAuthorization).toEqual(expect.arrayContaining(['Bearer session-a', 'Bearer session-b']))
    } finally {
      await Promise.all([runtimeA.dispose(), runtimeB.dispose()])
    }
  })
})
