/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterEach, describe, expect, test } from 'bun:test'
import type { AgentHarness } from '@earendil-works/pi-agent-core'
import type { AssistantMessage, MutableModels } from '@earendil-works/pi-ai'
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type FauxResponseStep,
} from '@earendil-works/pi-ai/providers/faux'
import { createHarnessRuntime } from '../agent/harness.ts'
import type { HarnessBindingTransaction, HarnessRuntime, PreparedPiBinding } from './types.ts'

const captureRejection = async (operation: Promise<unknown>): Promise<unknown> => {
  try {
    await operation
  } catch (error) {
    return error
  }
  throw new Error('Expected operation to reject.')
}

type PackageManifest = {
  readonly dependencies?: Readonly<Record<string, string>>
}

const packageManifest = (await Bun.file(new URL('../../package.json', import.meta.url)).json()) as PackageManifest

type TestBinding = {
  readonly binding: PreparedPiBinding
  readonly faux: ReturnType<typeof fauxProvider>
  readonly installedModels: MutableModels[]
  readonly attachedHarnesses: AgentHarness[]
  readonly observedErrors: unknown[]
  readonly counts: {
    install: number
    attach: number
    unsubscribe: number
    dispose: number
  }
}

const createTestBinding = (
  providerId: string,
  modelId: string,
  options: {
    readonly responses?: FauxResponseStep[]
    readonly events?: string[]
    readonly onAttach?: (harness: AgentHarness) => (() => void) | undefined
    readonly unsubscribeFailure?: Error
    readonly disposeFailures?: Error[]
    readonly installFailure?: Error
  } = {},
): TestBinding => {
  const faux = fauxProvider({ provider: providerId, models: [{ id: modelId }] })
  if (options.responses) faux.setResponses(options.responses)

  const installedModels: MutableModels[] = []
  const attachedHarnesses: AgentHarness[] = []
  const observedErrors: unknown[] = []
  const counts = { install: 0, attach: 0, unsubscribe: 0, dispose: 0 }
  const disposeFailures = [...(options.disposeFailures ?? [])]

  const binding: PreparedPiBinding = {
    providerId,
    wireModel: modelId,
    persistsCredentialStatus: false,
    piModel: faux.getModel(),
    install: (models) => {
      options.events?.push(`${providerId}:install`)
      counts.install += 1
      installedModels.push(models)
      if (options.installFailure) throw options.installFailure
      models.setProvider(faux.provider)
    },
    attach: (harness) => {
      options.events?.push(`${providerId}:attach`)
      counts.attach += 1
      attachedHarnesses.push(harness)
      const detachHook = options.onAttach?.(harness)
      let subscribed = true
      return () => {
        if (!subscribed) return
        options.events?.push(`${providerId}:unsubscribe`)
        counts.unsubscribe += 1
        if (options.unsubscribeFailure) throw options.unsubscribeFailure
        subscribed = false
        detachHook?.()
      }
    },
    observePromptError: async (error) => {
      observedErrors.push(error)
    },
    dispose: async () => {
      options.events?.push(`${providerId}:dispose`)
      counts.dispose += 1
      const failure = disposeFailures.shift()
      if (failure) throw failure
    },
  }

  return { binding, faux, installedModels, attachedHarnesses, observedErrors, counts }
}

const runtimes: HarnessRuntime[] = []

/** Records durable transaction phases with optional injected failures. */
const persistenceTransaction = (
  events: string[],
  failures: {
    readonly commit?: Error
    readonly rollback?: Error
    readonly finalize?: Error
  } = {},
): HarnessBindingTransaction => ({
  commit: async () => {
    events.push('persist')
    if (failures.commit) throw failures.commit
  },
  rollback: async () => {
    events.push('rollback-persist')
    if (failures.rollback) throw failures.rollback
  },
  finalize: async () => {
    events.push('finalize-persist')
    if (failures.finalize) throw failures.finalize
  },
})

const createRuntime = async (binding: PreparedPiBinding): Promise<HarnessRuntime> => {
  const runtime = await createHarnessRuntime(
    {
      cwd: process.cwd(),
      thinking: 'off',
    },
    binding,
  )
  runtimes.push(runtime)
  return runtime
}

afterEach(async () => {
  const pending = runtimes.splice(0)
  await Promise.allSettled(pending.map((runtime) => runtime.dispose()))
})

describe('CLI provider dependency alignment', () => {
  test('pins every Pi package to 0.80.7', () => {
    expect(packageManifest.dependencies).toMatchObject({
      '@earendil-works/pi-agent-core': '0.80.7',
      '@earendil-works/pi-ai': '0.80.7',
      '@earendil-works/pi-coding-agent': '0.80.7',
      '@earendil-works/pi-tui': '0.80.7',
    })
  })

})

describe('HarnessRuntime', () => {
  test('owns one harness, one mutable model registry, and one attached binding behind a narrow surface', async () => {
    const active = createTestBinding('profile-a', 'model-a')
    await createRuntime(active.binding)

    expect(active.counts).toMatchObject({ install: 1, attach: 1, unsubscribe: 0, dispose: 0 })
    expect(active.installedModels).toHaveLength(1)
    expect(active.attachedHarnesses).toHaveLength(1)
    expect(active.attachedHarnesses[0]?.models).toBe(active.installedModels[0])
    expect(active.installedModels[0]?.getModels()).toEqual([active.binding.piModel])
  })

  test('delegates event subscriptions and the tool-call gate without exposing the raw harness', async () => {
    const active = createTestBinding('profile-a', 'model-a', {
      responses: [
        fauxAssistantMessage(fauxToolCall('bash', { command: 'exit 99' })),
        fauxAssistantMessage('blocked safely'),
      ],
    })
    const runtime = await createRuntime(active.binding)
    const eventTypes: string[] = []
    const gatedTools: string[] = []
    const unsubscribe = runtime.subscribe((event) => {
      eventTypes.push(event.type)
    })
    runtime.registerToolCallGate(async (event) => {
      gatedTools.push(event.toolName)
      return { block: true, reason: 'test gate' }
    })

    const result = await runtime.prompt('use bash')
    unsubscribe()

    expect(result.stopReason).toBe('stop')
    expect(gatedTools).toEqual(['bash'])
    expect(eventTypes).toContain('agent_start')
    expect(active.faux.state.callCount).toBe(2)
  })

  test('passes steering text through to the active Pi harness', async () => {
    const firstResponse = Promise.withResolvers<AssistantMessage>()
    const firstResponseStarted = Promise.withResolvers<void>()
    const steeredContexts: unknown[] = []
    const active = createTestBinding('profile-a', 'model-a', {
      responses: [
        async () => {
          firstResponseStarted.resolve()
          return firstResponse.promise
        },
        (context) => {
          steeredContexts.push(context.messages.at(-1))
          return fauxAssistantMessage('steered')
        },
      ],
    })
    const runtime = await createRuntime(active.binding)
    const prompt = runtime.prompt('initial prompt')
    await firstResponseStarted.promise

    await runtime.steer('change direction')
    firstResponse.resolve(fauxAssistantMessage('first response'))
    const result = await prompt

    expect(result.content).toContainEqual({ type: 'text', text: 'steered' })
    expect(steeredContexts).toEqual([
      {
        role: 'user',
        content: [{ type: 'text', text: 'change direction' }],
        timestamp: expect.any(Number),
      },
    ])
  })

  test('observes a returned prompt error exactly once', async () => {
    const failedMessage = fauxAssistantMessage('', { stopReason: 'error', errorMessage: 'credential rejected' })
    const active = createTestBinding('profile-a', 'model-a', { responses: [failedMessage] })
    const runtime = await createRuntime(active.binding)

    const result = await runtime.prompt('fail')

    expect(result.stopReason).toBe('error')
    expect(active.observedErrors).toEqual([result])
  })

  test('observes a thrown prompt failure exactly once and rethrows it', async () => {
    const promptFailure = new Error('before-agent-start failed')
    const active = createTestBinding('profile-a', 'model-a', {
      onAttach: (harness) =>
        harness.on('before_agent_start', () => {
          throw promptFailure
        }),
    })
    const runtime = await createRuntime(active.binding)

    await expect(runtime.prompt('fail')).rejects.toThrow('before-agent-start failed')
    expect(active.observedErrors).toHaveLength(1)
  })

  test('rejects concurrent prompt, switch, and deactivation from its own prompt-active state', async () => {
    const response = Promise.withResolvers<AssistantMessage>()
    const active = createTestBinding('profile-a', 'model-a', { responses: [() => response.promise] })
    const candidate = createTestBinding('profile-b', 'model-b')
    const runtime = await createRuntime(active.binding)
    const promptPromise = runtime.prompt('slow')
    let deactivatePersistCalls = 0

    await expect(runtime.prompt('concurrent')).rejects.toThrow('prompt is active')
    await expect(
      runtime.switchBinding(candidate.binding, persistenceTransaction([]), { forceReplace: false }),
    ).rejects.toThrow('prompt is active')
    await expect(
      runtime.deactivate(
        async () => {
          deactivatePersistCalls += 1
        },
        { onPersistFailure: 'restore-binding' },
      ),
    ).rejects.toThrow('prompt is active')

    expect(candidate.counts.dispose).toBe(1)
    expect(deactivatePersistCalls).toBe(0)
    expect(active.observedErrors).toHaveLength(0)

    response.resolve(fauxAssistantMessage('done'))
    await promptPromise
  })

  test('switches binding in persist-activation-commit order and detaches the old provider', async () => {
    const events: string[] = []
    const active = createTestBinding('profile-a', 'model-a', { events })
    const candidate = createTestBinding('profile-b', 'model-b', { events })
    const runtime = await createRuntime(active.binding)
    const models = active.installedModels[0]
    runtime.subscribe((event) => {
      if (event.type === 'model_update') events.push(`model:${event.model.provider}/${event.model.id}`)
    })
    events.length = 0

    await runtime.switchBinding(candidate.binding, persistenceTransaction(events), { forceReplace: false })

    expect(events).toEqual([
      'persist',
      'profile-b:install',
      'profile-b:attach',
      'model:profile-b/model-b',
      'finalize-persist',
      'profile-a:unsubscribe',
      'profile-a:dispose',
    ])
    expect(models?.getProvider('profile-a')).toBeUndefined()
    expect(models?.getProvider('profile-b')).toBeDefined()
    expect(candidate.installedModels).toEqual([models])
    expect(runtime.currentProviderId()).toBe('profile-b')
  })

  test('does not alter the live binding when atomic persistence rejects', async () => {
    const events: string[] = []
    const active = createTestBinding('profile-a', 'model-a', {
      events,
      responses: [fauxAssistantMessage('old provider')],
    })
    const candidate = createTestBinding('profile-b', 'model-b', { events })
    const runtime = await createRuntime(active.binding)
    const models = active.installedModels[0]
    runtime.subscribe((event) => {
      if (event.type === 'model_update') events.push(`model:${event.model.provider}/${event.model.id}`)
    })
    events.length = 0

    await expect(
      runtime.switchBinding(candidate.binding, persistenceTransaction(events, { commit: new Error('disk full') }), {
        forceReplace: false,
      }),
    ).rejects.toThrow('disk full')

    expect(events).toEqual(['persist', 'profile-b:dispose'])
    expect(active.counts).toMatchObject({ attach: 1, unsubscribe: 0, dispose: 0 })
    expect(candidate.counts).toMatchObject({ attach: 0, unsubscribe: 0, dispose: 1 })
    expect(models?.getProvider('profile-a')).toBeDefined()
    expect(runtime.currentProviderId()).toBe('profile-a')
    expect(models?.getProvider('profile-b')).toBeUndefined()
    expect((await runtime.prompt('which provider?')).content).toContainEqual({ type: 'text', text: 'old provider' })
  })

  test('restores durable selection and the old provider when installation fails after persistence', async () => {
    const events: string[] = []
    const active = createTestBinding('profile-a', 'model-a', {
      events,
      responses: [fauxAssistantMessage('old provider')],
    })
    const installFailure = new Error('provider install failed')
    const candidate = createTestBinding('profile-b', 'model-b', { events, installFailure })
    const runtime = await createRuntime(active.binding)
    events.length = 0

    await expect(
      runtime.switchBinding(candidate.binding, persistenceTransaction(events), { forceReplace: false }),
    ).rejects.toBe(installFailure)

    expect(events).toEqual([
      'persist',
      'profile-b:install',
      'profile-a:install',
      'rollback-persist',
      'profile-b:dispose',
    ])
    expect((await runtime.prompt('which provider?')).content).toContainEqual({ type: 'text', text: 'old provider' })
  })

  test('restores durable selection and emits a truthful new-to-old pair after partial setModel failure', async () => {
    const events: string[] = []
    const active = createTestBinding('profile-a', 'model-a', {
      events,
      responses: [fauxAssistantMessage('old provider')],
    })
    const candidate = createTestBinding('profile-b', 'model-b', { events })
    const runtime = await createRuntime(active.binding)
    const harness = active.attachedHarnesses[0]
    if (!harness) throw new Error('active binding must attach to a harness')
    const setModel = harness.setModel.bind(harness)
    harness.setModel = async (model) => {
      await setModel(model)
      if (model.provider === candidate.binding.providerId) throw new Error('setModel failed after update')
    }
    runtime.subscribe((event) => {
      if (event.type === 'model_update') events.push(`model:${event.model.provider}/${event.model.id}`)
    })
    events.length = 0

    await expect(
      runtime.switchBinding(candidate.binding, persistenceTransaction(events), { forceReplace: false }),
    ).rejects.toThrow('setModel failed after update')

    expect(events).toEqual([
      'persist',
      'profile-b:install',
      'profile-b:attach',
      'model:profile-b/model-b',
      'profile-a:install',
      'model:profile-a/model-a',
      'profile-b:unsubscribe',
      'rollback-persist',
      'profile-b:dispose',
    ])
    expect((await runtime.prompt('which provider?')).content).toContainEqual({ type: 'text', text: 'old provider' })
  })

  test('force-replaces a same-provider credential closure without adding a model entry', async () => {
    const active = createTestBinding('profile-a', 'model-a', { responses: [fauxAssistantMessage('old closure')] })
    const candidate = createTestBinding('profile-a', 'model-a', { responses: [fauxAssistantMessage('new closure')] })
    const runtime = await createRuntime(active.binding)
    const models = active.installedModels[0]
    const modelUpdates: string[] = []
    runtime.subscribe((event) => {
      if (event.type === 'model_update') modelUpdates.push(event.model.id)
    })

    await runtime.switchBinding(candidate.binding, persistenceTransaction([]), { forceReplace: true })

    expect(models?.getProviders()).toHaveLength(1)
    expect(models?.getModels()).toEqual([candidate.binding.piModel])
    expect(modelUpdates).toEqual([])
    expect(active.counts).toMatchObject({ unsubscribe: 1, dispose: 1 })
    expect((await runtime.prompt('which closure?')).content).toContainEqual({ type: 'text', text: 'new closure' })
    expect(active.faux.state.callCount).toBe(0)
    expect(candidate.faux.state.callCount).toBe(1)
  })

  test('restores a deactivated binding when profile-removal persistence fails', async () => {
    const events: string[] = []
    const active = createTestBinding('profile-a', 'model-a', {
      events,
      responses: [fauxAssistantMessage('restored')],
    })
    const runtime = await createRuntime(active.binding)
    const models = active.installedModels[0]
    events.length = 0

    await expect(
      runtime.deactivate(
        async () => {
          events.push('persist')
          throw new Error('disk full')
        },
        { onPersistFailure: 'restore-binding' },
      ),
    ).rejects.toThrow('disk full')

    expect(events).toEqual(['profile-a:unsubscribe', 'persist', 'profile-a:install', 'profile-a:attach'])
    expect(active.counts).toMatchObject({ install: 2, attach: 2, unsubscribe: 1, dispose: 0 })
    expect(models?.getProvider('profile-a')).toBeDefined()
    expect((await runtime.prompt('still active?')).content).toContainEqual({ type: 'text', text: 'restored' })
  })

  test('retries a restore-binding unsubscribe failure during disposal', async () => {
    const unsubscribeFailure = new Error('unsubscribe failed')
    const active = createTestBinding('profile-a', 'model-a', { unsubscribeFailure })
    const runtime = await createRuntime(active.binding)

    await expect(
      runtime.deactivate(
        async () => {
          throw new Error('persistence must not run')
        },
        { onPersistFailure: 'restore-binding' },
      ),
    ).rejects.toBe(unsubscribeFailure)
    expect(active.counts.unsubscribe).toBe(1)

    await expect(runtime.dispose()).rejects.toThrow('Harness runtime disposal failed.')
    expect(active.counts.unsubscribe).toBeGreaterThan(1)
  })

  test('remains deactivated when local persistence fails after irreversible logout', async () => {
    const events: string[] = []
    const active = createTestBinding('thunderbolt', 'managed-model', { events })
    const runtime = await createRuntime(active.binding)
    const models = active.installedModels[0]
    events.length = 0

    await expect(
      runtime.deactivate(
        async () => {
          events.push('persist')
          throw new Error('disk full')
        },
        { onPersistFailure: 'remain-deactivated' },
      ),
    ).rejects.toThrow('disk full')

    expect(events).toEqual(['thunderbolt:unsubscribe', 'persist', 'thunderbolt:dispose'])
    expect(models?.getProvider('thunderbolt')).toBeUndefined()
    expect(runtime.currentProviderId()).toBeNull()
    expect(active.counts).toMatchObject({ attach: 1, unsubscribe: 1, dispose: 1 })
    await expect(runtime.prompt('must not run')).rejects.toThrow('deactivated')
  })

  test('finishes irreversible deactivation and aggregates unsubscribe, persistence, and disposal failures', async () => {
    const events: string[] = []
    const unsubscribeFailure = new Error('unsubscribe failed')
    const persistenceFailure = new Error('disk full')
    const disposalFailure = new Error('binding dispose failed')
    const active = createTestBinding('thunderbolt', 'managed-model', {
      events,
      unsubscribeFailure,
      disposeFailures: [disposalFailure],
    })
    const runtime = await createRuntime(active.binding)
    const models = active.installedModels[0]
    events.length = 0

    const failure = await captureRejection(
      runtime.deactivate(
        async () => {
          events.push('persist')
          throw persistenceFailure
        },
        { onPersistFailure: 'remain-deactivated' },
      ),
    )

    expect(failure).toBeInstanceOf(AggregateError)
    if (!(failure instanceof AggregateError)) throw new Error('expected aggregate deactivation failure')
    expect(failure.errors).toEqual([persistenceFailure, unsubscribeFailure, disposalFailure])
    expect(events).toEqual(['thunderbolt:unsubscribe', 'persist', 'thunderbolt:dispose'])
    expect(models?.getProvider('thunderbolt')).toBeUndefined()
    expect(active.counts).toMatchObject({ attach: 1, unsubscribe: 1, dispose: 1 })
    await expect(runtime.prompt('must not run')).rejects.toThrow('deactivated')
  })

  test('delegates abort to the harness', async () => {
    const active = createTestBinding('profile-a', 'model-a')
    const runtime = await createRuntime(active.binding)
    const events: string[] = []
    runtime.subscribe((event) => {
      events.push(event.type)
    })

    await runtime.abort()

    expect(events).toContain('abort')
  })

  test('retries post-commit binding cleanup during idempotent runtime disposal', async () => {
    const active = createTestBinding('profile-a', 'model-a', {
      disposeFailures: [new Error('old cleanup failed')],
    })
    const candidate = createTestBinding('profile-b', 'model-b', { responses: [fauxAssistantMessage('new active')] })
    const runtime = await createRuntime(active.binding)

    await expect(
      runtime.switchBinding(candidate.binding, persistenceTransaction([]), { forceReplace: false }),
    ).rejects.toThrow('old cleanup failed')
    expect((await runtime.prompt('still committed?')).content).toContainEqual({ type: 'text', text: 'new active' })

    await Promise.all([runtime.dispose(), runtime.dispose()])

    expect(active.counts.dispose).toBe(2)
    expect(candidate.counts).toMatchObject({ unsubscribe: 1, dispose: 1 })
  })

  test('disposes the active binding exactly once and rejects later operations', async () => {
    const active = createTestBinding('profile-a', 'model-a')
    const candidate = createTestBinding('profile-b', 'model-b')
    const runtime = await createRuntime(active.binding)

    await Promise.all([runtime.dispose(), runtime.dispose()])
    await runtime.dispose()

    expect(active.counts).toMatchObject({ unsubscribe: 1, dispose: 1 })
    await expect(runtime.prompt('after dispose')).rejects.toThrow('disposed')
    await expect(
      runtime.switchBinding(candidate.binding, persistenceTransaction([]), { forceReplace: false }),
    ).rejects.toThrow('disposed')
    expect(candidate.counts.dispose).toBe(1)
    await expect(runtime.deactivate(async () => {}, { onPersistFailure: 'restore-binding' })).rejects.toThrow(
      'disposed',
    )
  })
})
