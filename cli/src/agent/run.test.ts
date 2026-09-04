/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { Api, AssistantMessage, Model } from '@earendil-works/pi-ai'
import { describe, expect, test } from 'bun:test'
import { getEventListeners } from 'node:events'
import { PassThrough } from 'node:stream'
import { bundledManagedCatalog } from '../provider-runtime/catalog.ts'
import { defaultProviderStageContext } from '../provider-runtime/provider-stage.ts'
import { createProviderManager, runProviderManager } from '../provider-runtime/manager.ts'
import { createProviderRuntime, type ProviderRuntimeDependencies } from '../provider-runtime/runtime.ts'
import type {
  CliConfig,
  CommandOutcome,
  HarnessRuntime,
  InvocationSelection,
  PreparedPiBinding,
  ProviderCommand,
  ProviderManagerIO,
  ProviderRuntime,
  ProviderSnapshot,
} from '../provider-runtime/types.ts'
import { providerRuntimeError } from '../provider-runtime/types.ts'
import { createTerminalIOFromStreams, type TerminalIO } from '../ui/prompt.ts'
import { applyCommandOutcome, bootstrapBeforeHarness, createRunAgent, shouldUseTui } from './run.ts'
import type { RunAgentDependencies } from './run.ts'
import { permissionModeItems, type PermissionMode } from './permissions.ts'
import { builtinProviders, type CommandSyntaxRunConfig } from './types.ts'

const activeProviderId = 'byok-work'

const snapshot = (
  active: string | null = activeProviderId,
  status: 'authenticated' | 'authentication required' = 'authenticated',
): ProviderSnapshot => ({
  revision: 0,
  activeProviderId: active,
  thunderbolt: {
    status: 'not authenticated',
    defaultModelId: 'managed-default',
    models: [{ id: 'managed-default', label: 'Managed default' }],
  },
  providers: [
    {
      id: activeProviderId,
      label: 'Work',
      provider: 'openai',
      status,
      defaultModel: 'gpt-test',
      models: [{ id: 'gpt-test', label: 'GPT test' }],
    },
  ],
})

const binding = (providerId: string = activeProviderId): PreparedPiBinding => ({
  providerId,
  wireModel: 'test-model',
  persistsCredentialStatus: true,
  piModel: { provider: providerId, id: 'test-model' } as Model<Api>,
  install: () => {},
  attach: () => () => {},
  observePromptError: async () => {},
  dispose: async () => {},
})

const successMessage = { stopReason: 'stop' } as AssistantMessage

const harnessRuntime = (overrides: Partial<HarnessRuntime> = {}): HarnessRuntime => ({
  subscribe: () => () => {},
  registerToolCallGate: () => {},
  prompt: async () => successMessage,
  steer: async () => {},
  abort: async () => {},
  currentProviderId: () => activeProviderId,
  switchBinding: async () => {},
  deactivate: async () => {},
  dispose: async () => {},
  ...overrides,
})

const managerIO = (choices: readonly (string | null)[] = []): ProviderManagerIO => {
  const pending = [...choices]
  return {
    choose: async () => pending.shift() ?? null,
    readText: async () => null,
    readSecret: async () => null,
    write: () => {},
    showVerification: () => {},
    showStatus: () => {},
  }
}

const terminalIO = (lines: readonly (string | null)[] = []) => {
  const pending = [...lines]
  const writes: string[] = []
  const controller = new AbortController()
  let closes = 0
  const terminal: TerminalIO = {
    isTTY: false,
    readLine: async () => pending.shift() ?? null,
    readSecret: async () => pending.shift() ?? null,
    write: (text) => writes.push(text),
    ask: async () => 'deny',
    signal: controller.signal,
    close: () => {
      closes += 1
    },
  }
  return { terminal, signal: controller.signal, writes, closes: () => closes, abort: () => controller.abort() }
}

const runtime = (
  options: {
    readonly initial?: ProviderSnapshot
    readonly prepare?: (selection: InvocationSelection) => Promise<PreparedPiBinding>
    readonly manage?: (command: ProviderCommand) => Promise<ProviderSnapshot>
  } = {},
) => {
  const prepared: InvocationSelection[] = []
  const managed: ProviderCommand[] = []
  const initial = options.initial ?? snapshot()
  const providerRuntime: ProviderRuntime = {
    snapshot: () => initial,
    prepare: async (selection) => {
      prepared.push(selection)
      return options.prepare?.(selection) ?? binding(selection.providerId ?? activeProviderId)
    },
    manage: async (command) => {
      managed.push(command)
      return options.manage?.(command) ?? initial
    },
  }
  return { runtime: providerRuntime, prepared, managed }
}

/** Builds a real account runtime whose catalog-backed first-run flow is observable. */
const accountFirstRunRuntime = async (
  events: string[],
  loginGate?: Promise<void>,
  onLoginStart: () => void = () => {},
) => {
  const selectedModel = bundledManagedCatalog.data.find(({ isConfidential }) => isConfidential === 0)
  if (selectedModel === undefined) {
    throw new Error('The account first-run fixture requires a direct managed model.')
  }
  const deviceId = 'cli-00000000-0000-4000-8000-000000000001' as const
  const backendUrl = 'https://api.example.test/v1'
  const bearer = 'session-bearer'
  const userCacheSecret = new Uint8Array(32)
  const persisted: CliConfig[] = []
  const providerRuntime = await createProviderRuntime({
    loadConfig: async () => null,
    loadAuthConfig: async () => null,
    saveConfig: async (config) => {
      events.push('persist')
      persisted.push(config)
    },
    resolveAccountCredential: async () => ({
      type: 'session',
      backendUrl,
      bearer,
      deviceId,
      userCacheSecret,
    }),
    accountActions: {
      login: async () => {
        events.push('login')
        onLoginStart()
        await loginGate
        return {
          version: 2,
          backendUrl,
          deviceId,
          userCacheSecret: Buffer.from(userCacheSecret).toString('hex'),
          registration: 'registered',
          bearer,
        }
      },
      logout: async () => 'logged-out',
    },
    loadCatalog: async () => {
      events.push('catalog')
      return bundledManagedCatalog
    },
    ensureRegisteredSession: async (credential) => {
      events.push('register')
      return credential
    },
    markSessionAuthenticationRequired: async () => {},
    metadata: { deviceName: 'Run test' },
    createByokBinding: async () => {
      throw new Error('BYOK is not used by account first-run.')
    },
    createManagedDirectBinding: async ({ model }) => {
      events.push(`prepare:${model.id}`)
      return {
        ...binding('thunderbolt'),
        wireModel: model.model,
        piModel: { provider: 'thunderbolt', id: model.id } as Model<Api>,
      }
    },
    createTinfoilBinding: async () => {
      throw new Error('Confidential inference is not used by this direct-model fixture.')
    },
    environment: {},
    providerStage: defaultProviderStageContext,
  })

  return { persisted, runtime: providerRuntime, selectedModel }
}

/** Builds a one-shot run configuration with targeted overrides. */
const oneshot = (overrides: Partial<CommandSyntaxRunConfig> = {}): CommandSyntaxRunConfig =>
  ({
    cwd: process.cwd(),
    yolo: true,
    fullscreen: false,
    thinking: 'off',
    mode: 'oneshot',
    prompt: 'hi',
    selection: {},
    ...overrides,
  }) as CommandSyntaxRunConfig

/** Builds a REPL run configuration with targeted overrides. */
const repl = (overrides: Partial<CommandSyntaxRunConfig> = {}): CommandSyntaxRunConfig =>
  ({
    cwd: process.cwd(),
    yolo: true,
    fullscreen: false,
    thinking: 'off',
    mode: 'repl',
    noTui: false,
    selection: {},
    ...overrides,
  }) as CommandSyntaxRunConfig

const makeRunner = (overrides: Partial<RunAgentDependencies> = {}) =>
  createRunAgent({
    createTerminalIO: () => terminalIO().terminal,
    createHarnessRuntime: async () => harnessRuntime(),
    runTuiRepl: async (_runtime, options) => {
      await options.connect(managerIO(), new AbortController().signal)
    },
    runProviderManager,
    attachRenderer: () => {},
    attachPermissionGate: () => {},
    printBanner: () => {},
    setExitCode: () => {},
    terminalEnvironment: () => ({ interactive: true, stdoutIsTty: false, noTuiEnv: true }),
    ...overrides,
  })

describe('bootstrapBeforeHarness', () => {
  test('rejects non-interactive first run before preparing a provider', async () => {
    const state = runtime({ initial: snapshot(null) })

    await expect(bootstrapBeforeHarness(oneshot(), state.runtime, managerIO(), { interactive: false })).rejects.toThrow(
      /terminal.*provider/i,
    )
    expect(state.prepared).toEqual([])
    expect(state.managed).toEqual([])
  })

  test('does not reopen onboarding for an active migrated authentication-required profile', async () => {
    const repair = new Error('Repair credentials for byok-work before retrying.')
    const state = runtime({
      initial: snapshot(activeProviderId, 'authentication required'),
      prepare: async () => {
        throw repair
      },
    })
    let choices = 0
    const io: ProviderManagerIO = {
      ...managerIO(),
      choose: async () => {
        choices += 1
        return null
      },
    }

    await expect(bootstrapBeforeHarness(oneshot(), state.runtime, io, { interactive: true })).rejects.toBe(repair)
    expect(choices).toBe(0)
    expect(state.prepared).toEqual([{}])
  })

  test.each(['terminal cancellation', 'startup deadline'] as const)(
    'threads %s into managed registration and settles before harness construction',
    async (cause) => {
      const controller = new AbortController()
      const registrationStarted = Promise.withResolvers<void>()
      let receivedSignal: AbortSignal | undefined
      const providerRuntime = await createProviderRuntime({
        loadConfig: async () => ({
          version: 3,
          activeProviderId: 'thunderbolt',
          thunderbolt: { defaultModelId: bundledManagedCatalog.defaultModelId },
          providers: [],
        }),
        loadAuthConfig: async () => ({
          version: 2,
          backendUrl: 'https://api.example.test/v1',
          deviceId: 'cli-00000000-0000-4000-8000-000000000001',
          userCacheSecret: '00'.repeat(32),
          registration: 'registered',
          bearer: 'session-bearer',
        }),
        saveConfig: async () => {},
        resolveAccountCredential: async () => ({
          type: 'session',
          backendUrl: 'https://api.example.test/v1',
          deviceId: 'cli-00000000-0000-4000-8000-000000000001',
          userCacheSecret: new Uint8Array(32),
          bearer: 'session-bearer',
        }),
        accountActions: {
          login: async () => {
            throw new Error('unexpected login')
          },
          logout: async () => 'logged-out',
        },
        loadCatalog: async () => bundledManagedCatalog,
        ensureRegisteredSession: async (credential, _metadata, _fetchFn, signal) => {
          receivedSignal = signal
          registrationStarted.resolve()
          if (signal === undefined) return new Promise<never>(() => {})
          if (signal.aborted) throw signal.reason
          const aborted = Promise.withResolvers<never>()
          signal.addEventListener('abort', () => aborted.reject(signal.reason), { once: true })
          await aborted.promise
          return credential
        },
        markSessionAuthenticationRequired: async () => {},
        metadata: { deviceName: 'Test CLI' },
        createByokBinding: async () => {
          throw new Error('unexpected BYOK binding')
        },
        createManagedDirectBinding: async () => {
          throw new Error('binding must not be built after cancellation')
        },
        createTinfoilBinding: async () => {
          throw new Error('binding must not be built after cancellation')
        },
        environment: {},
        providerStage: defaultProviderStageContext,
      })

      const signal = cause === 'terminal cancellation' ? controller.signal : AbortSignal.timeout(5)
      const pending = bootstrapBeforeHarness(oneshot(), providerRuntime, managerIO(), {
        interactive: false,
        signal,
      })
      await registrationStarted.promise
      if (cause === 'terminal cancellation') controller.abort()

      await expect(pending).rejects.toMatchObject({
        name: cause === 'terminal cancellation' ? 'AbortError' : 'TimeoutError',
      })
      expect(receivedSignal).toBeDefined()
      expect(receivedSignal?.aborted).toBeTrue()
    },
  )

  test('logs in, selects a catalog model, prepares it, and atomically activates the account', async () => {
    const events: string[] = []
    const account = await accountFirstRunRuntime(events)

    const result = await bootstrapBeforeHarness(
      oneshot(),
      account.runtime,
      managerIO(['thunderbolt-account', account.selectedModel.id]),
      { interactive: true },
    )

    expect(result.binding.providerId).toBe('thunderbolt')
    expect(result.binding.piModel.id).toBe(account.selectedModel.id)
    expect(result.config.selection).toEqual({ providerId: 'thunderbolt', model: account.selectedModel.id })
    expect(events).toEqual([
      'login',
      'catalog',
      'catalog',
      'register',
      `prepare:${account.selectedModel.id}`,
      'persist',
    ])
    expect(account.persisted).toHaveLength(1)
    expect(account.persisted[0]).toMatchObject({
      activeProviderId: 'thunderbolt',
      thunderbolt: { defaultModelId: account.selectedModel.id },
    })
  })

  test('forwards the terminal abort signal through first-run account login', async () => {
    const controller = new AbortController()
    let loginSignal: AbortSignal | undefined
    const state = runtime({
      initial: snapshot(null),
      manage: async (command) => {
        if (command.type === 'login') {
          loginSignal = command.signal
          return snapshot(null)
        }
        return snapshot(command.type === 'use' ? command.providerId : null)
      },
    })

    await bootstrapBeforeHarness(oneshot(), state.runtime, managerIO(['thunderbolt-account']), {
      interactive: true,
      signal: controller.signal,
    })

    expect(loginSignal).toBe(controller.signal)
  })

  test('disposes the prepared first-run binding when persistence fails', async () => {
    let disposals = 0
    const persistFailure = new Error('disk full')
    const state = runtime({
      initial: snapshot(null),
      prepare: async () => ({
        ...binding('thunderbolt'),
        dispose: async () => {
          disposals += 1
        },
      }),
      manage: async (command) => {
        if (command.type === 'use') throw persistFailure
        return snapshot(null)
      },
    })

    await expect(
      bootstrapBeforeHarness(oneshot(), state.runtime, managerIO(['thunderbolt-account']), { interactive: true }),
    ).rejects.toBe(persistFailure)
    expect(disposals).toBe(1)
    expect(state.prepared).toHaveLength(1)
    expect(state.managed.map(({ type }) => type)).toEqual(['login', 'use'])
  })
})

describe('applyCommandOutcome', () => {
  test('gives a switch to HarnessRuntime as one prepare and one deferred atomic persistence callback', async () => {
    const events: string[] = []
    const state = runtime({
      prepare: async (selection) => {
        events.push(`prepare:${selection.providerId}`)
        return binding(selection.providerId)
      },
      manage: async (command) => {
        events.push(`manage:${command.type}`)
        return snapshot(command.type === 'use' ? command.providerId : activeProviderId)
      },
    })
    let switches = 0
    const harness = harnessRuntime({
      switchBinding: async (candidate, transaction, options) => {
        switches += 1
        events.push(`switch:${candidate.providerId}:${options.forceReplace}`)
        await transaction.commit()
        await transaction.finalize()
      },
    })
    const outcome: CommandOutcome = {
      kind: 'switch',
      selection: { providerId: 'byok-next', apiKey: 'ephemeral' },
      persist: { type: 'use', providerId: 'byok-next' },
      forceReplace: true,
    }

    await expect(applyCommandOutcome(outcome, state.runtime, harness)).resolves.toEqual(outcome.selection)
    expect(switches).toBe(1)
    expect(state.prepared).toEqual([outcome.selection])
    expect(state.managed).toEqual([
      { type: 'commit-persistence', command: outcome.persist },
      { type: 'finalize-persistence', revision: 0 },
    ])
    expect(events).toEqual([
      'prepare:byok-next',
      'switch:byok-next:true',
      'manage:commit-persistence',
      'manage:finalize-persistence',
    ])
  })

  test('uses remain-deactivated for irreversible clear-active and restore-binding for BYOK removal', async () => {
    const modes: string[] = []
    const state = runtime()
    const harness = harnessRuntime({
      deactivate: async (persist, options) => {
        modes.push(options.onPersistFailure)
        await persist()
      },
    })

    await applyCommandOutcome({ kind: 'deactivate', persist: { type: 'clear-active' } }, state.runtime, harness)
    await applyCommandOutcome(
      { kind: 'deactivate', persist: { type: 'remove-byok', providerId: activeProviderId } },
      state.runtime,
      harness,
    )

    expect(modes).toEqual(['remain-deactivated', 'restore-binding'])
    expect(state.managed).toEqual([{ type: 'clear-active' }, { type: 'remove-byok', providerId: activeProviderId }])
    expect(state.prepared).toEqual([])
  })

  test('deactivates the live account binding before surfacing confirmed-logout persistence failure', async () => {
    const failure = Object.assign(providerRuntimeError('persistence-failed', 'local auth clear failed'), {
      remoteLogoutConfirmed: true as const,
    })
    const events: string[] = []
    const state = runtime({ initial: snapshot('thunderbolt') })
    const harness = harnessRuntime({
      deactivate: async (persist) => {
        events.push('deactivate')
        await persist()
      },
    })

    await expect(
      applyCommandOutcome({ kind: 'deactivate', persist: null, failure }, state.runtime, harness),
    ).rejects.toBe(failure)

    expect(events).toEqual(['deactivate'])
  })

  test('handled and exit do nothing while forward prompts exactly once through HarnessRuntime', async () => {
    const prompts: string[] = []
    const state = runtime()
    const harness = harnessRuntime({
      prompt: async (text) => {
        prompts.push(text)
        return successMessage
      },
    })

    await expect(applyCommandOutcome({ kind: 'handled' }, state.runtime, harness)).resolves.toBeNull()
    await expect(applyCommandOutcome({ kind: 'exit' }, state.runtime, harness)).resolves.toBeNull()
    await expect(applyCommandOutcome({ kind: 'forward', text: 'hello' }, state.runtime, harness)).resolves.toBeNull()
    expect(prompts).toEqual(['hello'])
    expect(state.prepared).toEqual([])
    expect(state.managed).toEqual([])
  })
})

describe('runAgent orchestration', () => {
  test.each([
    ['fullscreen', repl({ fullscreen: true }), { fullscreen: true }],
    ['yolo', repl({ yolo: true }), { initialPermissionMode: 'yolo' }],
    ['thinking', repl({ thinking: 'high' }), { thinking: 'high' }],
  ] as const)('threads %s into the TUI', async (_name, config, expected) => {
    const state = runtime()
    const tuiCalls: Parameters<RunAgentDependencies['runTuiRepl']>[1][] = []
    const runner = makeRunner({
      runTuiRepl: async (_runtime, options) => {
        tuiCalls.push(options)
        await options.connect(managerIO(), new AbortController().signal)
      },
      terminalEnvironment: () => ({ interactive: true, stdoutIsTty: true, noTuiEnv: false }),
    })

    await runner(config, state.runtime)

    expect(tuiCalls).toHaveLength(1)
    expect(tuiCalls[0]).toMatchObject(expected)
  })

  test('uses the plain path and rejects first-run setup when stdin is piped but stdout is a TTY', async () => {
    const terminal = terminalIO()
    const state = runtime({ initial: snapshot(null) })
    let tuiRuns = 0
    const runner = makeRunner({
      createTerminalIO: () => terminal.terminal,
      runTuiRepl: async () => {
        tuiRuns += 1
      },
      terminalEnvironment: () => ({ interactive: false, stdoutIsTty: true, noTuiEnv: false }),
    })

    await expect(runner(repl(), state.runtime)).rejects.toThrow(
      'Run thunderbolt in a terminal to choose a provider before starting inference.',
    )
    expect(tuiRuns).toBe(0)
    expect(terminal.closes()).toBe(1)
  })

  test('disposes a TUI harness when the TUI rejects after connection', async () => {
    const cancellation = new Error('Provider setup was cancelled before a provider was selected.')
    const state = runtime()
    let disposals = 0
    const runner = makeRunner({
      createHarnessRuntime: async () =>
        harnessRuntime({
          dispose: async () => {
            disposals += 1
          },
        }),
      runTuiRepl: async (_runtime, options) => {
        await options.connect(managerIO(), new AbortController().signal)
        throw cancellation
      },
      terminalEnvironment: () => ({ interactive: true, stdoutIsTty: true, noTuiEnv: false }),
    })

    await expect(runner(repl(), state.runtime)).rejects.toBe(cancellation)
    expect(disposals).toBe(1)
  })

  test('keeps an initial BYOK override live for /models without replacing the saved Thunderbolt default', async () => {
    const terminal = terminalIO(['/models', '1', 'exit'])
    const state = runtime({ initial: snapshot('thunderbolt') })
    const switchedProviders: string[] = []
    const runner = makeRunner({
      createTerminalIO: () => terminal.terminal,
      createHarnessRuntime: async (_config, preparedBinding) =>
        harnessRuntime({
          currentProviderId: () => preparedBinding.providerId,
          switchBinding: async (candidate, transaction) => {
            switchedProviders.push(candidate.providerId)
            await transaction.commit()
            await transaction.finalize()
          },
        }),
    })

    await runner(repl({ selection: { providerId: activeProviderId } }), state.runtime)

    expect(switchedProviders).toEqual([activeProviderId])
    expect(state.managed).toEqual([
      {
        type: 'commit-persistence',
        command: { type: 'select-model', providerId: activeProviderId, model: 'gpt-test' },
      },
      { type: 'finalize-persistence', revision: 0 },
    ])
  })

  test('deactivates a live Thunderbolt override on logout without clearing the saved BYOK default', async () => {
    const terminal = terminalIO(['/logout', 'exit'])
    const state = runtime({ initial: snapshot(activeProviderId) })
    let deactivations = 0
    const runner = makeRunner({
      createTerminalIO: () => terminal.terminal,
      createHarnessRuntime: async (_config, preparedBinding) =>
        harnessRuntime({
          currentProviderId: () => preparedBinding.providerId,
          deactivate: async (persist) => {
            deactivations += 1
            await persist()
          },
        }),
    })

    await runner(repl({ selection: { providerId: 'thunderbolt' } }), state.runtime)

    expect(deactivations).toBe(1)
    expect(state.managed).toHaveLength(1)
    expect(state.managed[0]).toMatchObject({ type: 'logout' })
  })

  test('plain REPL applies authoritative logout deactivation when terminal cancellation races with its response', async () => {
    const terminal = terminalIO(['/logout'])
    const state = runtime({
      initial: snapshot('thunderbolt'),
      manage: async (command) => {
        if (command.type === 'logout') terminal.abort()
        return snapshot(null)
      },
    })
    let deactivations = 0
    const runner = makeRunner({
      createTerminalIO: () => terminal.terminal,
      createHarnessRuntime: async (_config, preparedBinding) =>
        harnessRuntime({
          currentProviderId: () => preparedBinding.providerId,
          deactivate: async (persist) => {
            deactivations += 1
            await persist()
          },
        }),
    })

    await runner(repl({ selection: { providerId: 'thunderbolt' } }), state.runtime)

    expect(deactivations).toBe(1)
  })

  test('first-run Ctrl-D aborts account login before persistence or harness construction', async () => {
    const terminal = terminalIO(['1'])
    const loginStarted = Promise.withResolvers<void>()
    const releaseLogin = Promise.withResolvers<void>()
    let loginSignal: AbortSignal | undefined
    let harnessConstructions = 0
    const state = runtime({
      initial: snapshot(null),
      manage: async (command) => {
        if (command.type !== 'login') return snapshot(command.type === 'use' ? command.providerId : null)
        loginSignal = command.signal
        loginStarted.resolve()
        await releaseLogin.promise
        if (loginSignal?.aborted) throw loginSignal.reason
        return snapshot(null)
      },
    })
    const runner = makeRunner({
      createTerminalIO: () => terminal.terminal,
      createHarnessRuntime: async () => {
        harnessConstructions += 1
        return harnessRuntime()
      },
    })

    const running = runner(repl({ noTui: true }), state.runtime)
    await loginStarted.promise
    terminal.abort()
    const signalWasForwarded = loginSignal === terminal.terminal.signal
    releaseLogin.resolve()

    await expect(running).rejects.toMatchObject({ name: 'AbortError' })
    expect(signalWasForwarded).toBeTrue()
    expect(state.managed.map(({ type }) => type)).toEqual(['login'])
    expect(harnessConstructions).toBe(0)
  })

  test('starts TUI onboarding before login without constructing a plain terminal', async () => {
    const events: string[] = []
    const login = Promise.withResolvers<void>()
    const loginStarted = Promise.withResolvers<void>()
    const account = await accountFirstRunRuntime(events, login.promise, loginStarted.resolve)
    const harness = harnessRuntime()
    let terminalConstructions = 0
    const runner = makeRunner({
      createTerminalIO: () => {
        terminalConstructions += 1
        return terminalIO().terminal
      },
      createHarnessRuntime: async () => {
        events.push('harness')
        return harness
      },
      runTuiRepl: async (_runtime, options) => {
        events.push('tui')
        await options.connect(
          managerIO(['thunderbolt-account', account.selectedModel.id]),
          new AbortController().signal,
        )
      },
      terminalEnvironment: () => ({ interactive: true, stdoutIsTty: true, noTuiEnv: false }),
    })

    const running = runner(repl(), account.runtime)
    await loginStarted.promise
    expect(events).toEqual(['tui', 'login'])

    login.resolve()
    await running

    expect(events).toEqual([
      'tui',
      'login',
      'catalog',
      'catalog',
      'register',
      `prepare:${account.selectedModel.id}`,
      'persist',
      'harness',
    ])
    expect(account.persisted[0]).toMatchObject({
      activeProviderId: 'thunderbolt',
      thunderbolt: { defaultModelId: account.selectedModel.id },
    })
    expect(terminalConstructions).toBe(0)
  })

  test('first-run BYOK creation selects a model and atomically persists activation before one harness prompt', async () => {
    const providerManager = createProviderManager({
      providerStage: defaultProviderStageContext,
      listByokModels: async ({ baseUrl, apiKey }) => {
        expect(baseUrl).toBe('https://models.example.test/v1')
        expect(apiKey).toBe('private-key')
        return { source: 'live', ids: ['model-alpha', 'model-beta'], authenticated: true }
      },
    })
    {
      const persisted: CliConfig[] = []
      const dependencies: ProviderRuntimeDependencies = {
        loadConfig: async () => null,
        loadAuthConfig: async () => null,
        saveConfig: async (config) => {
          persisted.push(config)
        },
        resolveAccountCredential: async () => null,
        accountActions: {
          login: async () => {
            throw new Error('account login is not used by BYOK setup')
          },
          logout: async () => 'authentication-required',
        },
        loadCatalog: async () => bundledManagedCatalog,
        ensureRegisteredSession: async (credential) => credential,
        markSessionAuthenticationRequired: async () => {},
        metadata: { deviceName: 'Task 14 test' },
        createByokBinding: async (profile) => {
          expect(profile.credentialStatus).toBe('authenticated')
          return {
            ...binding(profile.id),
            wireModel: profile.defaultModel,
            piModel: { provider: profile.id, id: profile.defaultModel } as Model<Api>,
          }
        },
        createManagedDirectBinding: async () => {
          throw new Error('managed direct is not used by BYOK setup')
        },
        createTinfoilBinding: async () => {
          throw new Error('Tinfoil is not used by BYOK setup')
        },
        environment: {},
        providerStage: defaultProviderStageContext,
      }
      const providerRuntime = await createProviderRuntime(dependencies)
      const events: string[] = []
      const managed: ProviderCommand[] = []
      const prepared: InvocationSelection[] = []
      const trackedRuntime: ProviderRuntime = {
        snapshot: providerRuntime.snapshot,
        manage: async (command) => {
          managed.push(command)
          if (command.type === 'commit-staged-byok' && command.activate) events.push('persist')
          return providerRuntime.manage(command)
        },
        prepare: async (selection) => {
          prepared.push(selection)
          events.push('prepare')
          return providerRuntime.prepare(selection)
        },
      }
      const baseUrl = 'https://models.example.test/v1'
      const customProviderChoice = String(builtinProviders.length + 3)
      const terminal = terminalIO(['2', customProviderChoice, 'Task profile', baseUrl, 'private-key', '2'])
      const prompts: string[] = []
      let constructions = 0
      const runner = makeRunner({
        createTerminalIO: () => terminal.terminal,
        runProviderManager: providerManager,
        createHarnessRuntime: async (_config, preparedBinding) => {
          constructions += 1
          events.push('construct')
          expect(preparedBinding.piModel.id).toBe('model-beta')
          return harnessRuntime({
            prompt: async (text) => {
              prompts.push(text)
              events.push('prompt')
              return successMessage
            },
          })
        },
        terminalEnvironment: () => ({ interactive: true, stdoutIsTty: false, noTuiEnv: false }),
      })

      await runner(oneshot({ prompt: 'original BYOK prompt' }), trackedRuntime)

      const activation = managed.find(
        (command): command is Extract<ProviderCommand, { type: 'commit-staged-byok' }> =>
          command.type === 'commit-staged-byok' && command.activate,
      )
      expect(activation).toBeDefined()
      expect(managed.filter(({ type }) => type === 'commit-staged-byok')).toHaveLength(1)
      expect(prepared).toEqual([{ providerId: activation!.providerId }])
      expect(JSON.stringify({ prepared, activation })).not.toContain('private-key')
      const saved = persisted.at(-1)
      expect(saved?.activeProviderId).toBe(activation!.providerId)
      expect(saved?.providers[0]).toMatchObject({
        id: activation!.providerId,
        defaultModel: 'model-beta',
        credentialStatus: 'authenticated',
      })
      expect(providerRuntime.snapshot().activeProviderId).toBe(activation!.providerId)
      expect(constructions).toBe(1)
      expect(prompts).toEqual(['original BYOK prompt'])
      expect(events).toEqual(['prepare', 'persist', 'construct', 'prompt'])
      expect(terminal.closes()).toBe(1)
    }
  })

  test('runs the original one-shot prompt once after bootstrap and disposes the runtime', async () => {
    const prompts: string[] = []
    let harnessDisposals = 0
    let constructions = 0
    const state = runtime()
    const terminal = terminalIO()
    const harness = harnessRuntime({
      prompt: async (text) => {
        prompts.push(text)
        return successMessage
      },
      dispose: async () => {
        harnessDisposals += 1
      },
    })
    const runner = makeRunner({
      createTerminalIO: () => terminal.terminal,
      createHarnessRuntime: async () => {
        constructions += 1
        return harness
      },
      terminalEnvironment: () => ({ interactive: false, stdoutIsTty: false, noTuiEnv: false }),
    })

    await runner(oneshot({ prompt: 'original prompt' }), state.runtime)

    expect(state.prepared).toEqual([{}])
    expect(constructions).toBe(1)
    expect(prompts).toEqual(['original prompt'])
    expect(harnessDisposals).toBe(1)
    expect(terminal.closes()).toBe(1)
  })

  test('runs an argv one-shot after stdin has already reached EOF', async () => {
    const input = new PassThrough()
    const terminal = createTerminalIOFromStreams(input, new PassThrough())
    const eof = terminal.readLine('')
    input.end()
    await expect(eof).resolves.toBeNull()
    const prompts: string[] = []
    const state = runtime()
    const runner = makeRunner({
      createTerminalIO: () => terminal,
      createHarnessRuntime: async () =>
        harnessRuntime({
          prompt: async (prompt) => {
            prompts.push(prompt)
            return successMessage
          },
        }),
      terminalEnvironment: () => ({ interactive: false, stdoutIsTty: false, noTuiEnv: true }),
    })

    await runner(oneshot({ prompt: 'argv prompt' }), state.runtime)

    expect(prompts).toEqual(['argv prompt'])
  })

  test('one-shot SIGINT aborts an active harness prompt and removes its scoped listener', async () => {
    const terminal = terminalIO()
    const promptStarted = Promise.withResolvers<void>()
    const promptCompleted = Promise.withResolvers<AssistantMessage>()
    let aborts = 0
    const exitCodes: number[] = []
    const state = runtime()
    const runner = makeRunner({
      createTerminalIO: () => terminal.terminal,
      createHarnessRuntime: async () =>
        harnessRuntime({
          prompt: async () => {
            promptStarted.resolve()
            return promptCompleted.promise
          },
          abort: async () => {
            aborts += 1
            promptCompleted.resolve(successMessage)
          },
        }),
      terminalEnvironment: () => ({ interactive: false, stdoutIsTty: false, noTuiEnv: false }),
      setExitCode: (code) => exitCodes.push(code),
    })

    const running = runner(oneshot(), state.runtime)
    await promptStarted.promise
    expect(getEventListeners(terminal.signal, 'abort')).toHaveLength(1)
    terminal.abort()
    await running

    expect(aborts).toBe(1)
    expect(exitCodes).toEqual([130])
    expect(getEventListeners(terminal.signal, 'abort')).toHaveLength(0)
  })

  test('one-shot with an already-aborted signal stops before provider or harness construction', async () => {
    const terminal = terminalIO()
    terminal.abort()
    let constructions = 0
    let prompts = 0
    const state = runtime()
    const runner = makeRunner({
      createTerminalIO: () => terminal.terminal,
      createHarnessRuntime: async () => {
        constructions += 1
        return harnessRuntime({
          prompt: async () => {
            prompts += 1
            return successMessage
          },
        })
      },
      terminalEnvironment: () => ({ interactive: false, stdoutIsTty: false, noTuiEnv: false }),
    })

    await expect(runner(oneshot(), state.runtime)).rejects.toMatchObject({ name: 'AbortError' })

    expect(state.prepared).toEqual([])
    expect(constructions).toBe(0)
    expect(prompts).toBe(0)
    expect(getEventListeners(terminal.signal, 'abort')).toHaveLength(0)
  })

  test('persistence failure constructs no harness and never runs the original prompt', async () => {
    let constructions = 0
    let bindingDisposals = 0
    const state = runtime({
      initial: snapshot(null),
      prepare: async () => ({
        ...binding('thunderbolt'),
        dispose: async () => {
          bindingDisposals += 1
        },
      }),
      manage: async (command) => {
        if (command.type === 'use') throw new Error('persist failed')
        return snapshot(null)
      },
    })
    const terminal = terminalIO(['1'])
    const runner = makeRunner({
      createTerminalIO: () => terminal.terminal,
      createHarnessRuntime: async () => {
        constructions += 1
        return harnessRuntime()
      },
      terminalEnvironment: () => ({ interactive: true, stdoutIsTty: false, noTuiEnv: false }),
    })

    await expect(runner(oneshot({ prompt: 'must not run' }), state.runtime)).rejects.toThrow('persist failed')
    expect(constructions).toBe(0)
    expect(bindingDisposals).toBe(1)
    expect(terminal.closes()).toBe(1)
  })

  for (const phase of ['login', 'prepare'] as const) {
    test(`failed initial ${phase} constructs no harness or prompt`, async () => {
      const failure = new Error(`${phase} failed`)
      let constructions = 0
      const state = runtime({
        initial: snapshot(phase === 'login' ? null : activeProviderId),
        prepare: async () => {
          if (phase === 'prepare') throw failure
          return binding('thunderbolt')
        },
        manage: async (command) => {
          if (phase === 'login' && command.type === 'login') throw failure
          return snapshot(null)
        },
      })
      const terminal = terminalIO(phase === 'login' ? ['1'] : [])
      const runner = makeRunner({
        createTerminalIO: () => terminal.terminal,
        createHarnessRuntime: async () => {
          constructions += 1
          return harnessRuntime()
        },
        terminalEnvironment: () => ({ interactive: true, stdoutIsTty: false, noTuiEnv: false }),
      })

      await expect(runner(oneshot({ prompt: 'must not run' }), state.runtime)).rejects.toBe(failure)
      expect(constructions).toBe(0)
      expect(terminal.closes()).toBe(1)
    })
  }

  test('interactive prompt errors render and a later login does not replay the failed prompt', async () => {
    const prompts: string[] = []
    const terminal = terminalIO(['broken prompt', '/login', 'exit'])
    const state = runtime()
    const harness = harnessRuntime({
      prompt: async (text) => {
        prompts.push(text)
        throw new Error('provider\x1b[2J rejected prompt')
      },
    })
    const runner = makeRunner({
      createTerminalIO: () => terminal.terminal,
      createHarnessRuntime: async () => harness,
    })

    await runner(repl({ noTui: true }), state.runtime)

    expect(prompts).toEqual(['broken prompt'])
    expect(state.managed.map(({ type }) => type)).toEqual(['login', 'select-model'])
    expect(terminal.writes.join('')).toContain('provider rejected prompt')
    expect(terminal.writes.join('')).not.toContain('2J')
  })

  test.each(['login', 'logout'] as const)(
    'plain REPL passes the terminal abort signal through /%s and waits for its settlement',
    async (action) => {
      const terminal = terminalIO([`/${action}`, null])
      const started = Promise.withResolvers<void>()
      const settled = Promise.withResolvers<void>()
      let receivedSignal: AbortSignal | undefined
      const state = runtime({
        manage: async (command) => {
          if (command.type !== action) return snapshot()
          receivedSignal = command.signal
          started.resolve()
          await settled.promise
          return snapshot()
        },
      })
      const runner = makeRunner({
        createTerminalIO: () => terminal.terminal,
      })

      const running = runner(repl({ noTui: true }), state.runtime)
      await started.promise
      terminal.abort()
      const signalWasForwarded = receivedSignal === terminal.terminal.signal
      settled.resolve()
      await running

      expect(signalWasForwarded).toBeTrue()
    },
  )

  test('plain REPL aborts an active harness prompt when the terminal closes', async () => {
    const terminal = terminalIO(['active prompt', null])
    const started = Promise.withResolvers<void>()
    const complete = Promise.withResolvers<AssistantMessage>()
    let aborts = 0
    const state = runtime()
    const harness = harnessRuntime({
      prompt: async () => {
        started.resolve()
        return complete.promise
      },
      abort: async () => {
        aborts += 1
      },
    })
    const runner = makeRunner({
      createTerminalIO: () => terminal.terminal,
      createHarnessRuntime: async () => harness,
    })

    const running = runner(repl({ noTui: true }), state.runtime)
    await started.promise
    terminal.abort()
    await Promise.resolve()

    const abortsAfterClose = aborts
    complete.resolve(successMessage)
    await running

    expect(abortsAfterClose).toBe(1)
  })

  test('plain REPL drops whitespace-only input but forwards nonblank text byte-for-byte', async () => {
    const prompts: string[] = []
    const terminal = terminalIO(['   ', ' /exit ', 'exit'])
    const state = runtime()
    const runner = makeRunner({
      createTerminalIO: () => terminal.terminal,
      createHarnessRuntime: async () =>
        harnessRuntime({
          prompt: async (text) => {
            prompts.push(text)
            return successMessage
          },
        }),
    })

    await runner(repl({ noTui: true }), state.runtime)

    expect(prompts).toEqual([' /exit '])
  })

  test('/permissions changes the live mode through plain manager IO and offers every mode', async () => {
    const selected = permissionModeItems.find(({ id }) => id === 'accept-edits')!
    const selectedIndex = permissionModeItems.findIndex(({ id }) => id === selected.id) + 1
    const terminal = terminalIO(['/permissions', String(selectedIndex), 'exit'])
    const state = runtime()
    let getMode: (() => PermissionMode) | undefined
    const runner = makeRunner({
      createTerminalIO: () => terminal.terminal,
      attachPermissionGate: (_harness, options) => {
        getMode = options.getMode
      },
    })

    await runner(repl({ noTui: true, yolo: false }), state.runtime)

    expect(getMode?.()).toBe(selected.id)
    expect(terminal.writes.join('')).toContain(selected.label)
    expect(terminal.writes.join('')).toContain(permissionModeItems.find(({ id }) => id === 'yolo')!.label)
  })

  test('one-shot provider errors set a nonzero exit code', async () => {
    const exitCodes: number[] = []
    const terminal = terminalIO()
    const state = runtime()
    const harness = harnessRuntime({
      prompt: async () => ({ ...successMessage, stopReason: 'error', errorMessage: 'bad credential' }),
    })
    const runner = makeRunner({
      createTerminalIO: () => terminal.terminal,
      createHarnessRuntime: async () => harness,
      setExitCode: (code) => exitCodes.push(code),
      terminalEnvironment: () => ({ interactive: false, stdoutIsTty: false, noTuiEnv: false }),
    })

    await runner(oneshot(), state.runtime)
    expect(exitCodes).toEqual([1])
  })

  test('closes the shared terminal even when harness disposal fails', async () => {
    const cleanupFailure = new Error('harness cleanup failed')
    const terminal = terminalIO()
    const state = runtime()
    const runner = makeRunner({
      createTerminalIO: () => terminal.terminal,
      createHarnessRuntime: async () =>
        harnessRuntime({
          dispose: async () => {
            throw cleanupFailure
          },
        }),
      terminalEnvironment: () => ({ interactive: false, stdoutIsTty: false, noTuiEnv: false }),
    })

    await expect(runner(oneshot(), state.runtime)).rejects.toBe(cleanupFailure)
    expect(terminal.closes()).toBe(1)
  })
})

describe('shouldUseTui — REPL mode selection', () => {
  test('a REPL on a TTY with no opt-out uses the TUI', () => {
    expect(shouldUseTui(repl(), { isTty: true, noTuiEnv: false })).toBe(true)
  })

  test('a piped (non-TTY) REPL falls back to the plain loop', () => {
    expect(shouldUseTui(repl(), { isTty: false, noTuiEnv: false })).toBe(false)
  })

  test('THUNDERBOLT_NO_TUI forces the plain loop even on a TTY', () => {
    expect(shouldUseTui(repl(), { isTty: true, noTuiEnv: true })).toBe(false)
  })

  test('the --no-tui flag forces the plain loop even on a TTY', () => {
    expect(shouldUseTui(repl({ noTui: true }), { isTty: true, noTuiEnv: false })).toBe(false)
  })

  test('oneshot runs never use the TUI, even on a TTY', () => {
    expect(shouldUseTui(oneshot(), { isTty: true, noTuiEnv: false })).toBe(false)
  })
})
