/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/** Contract tests for the pure argv parser and the production help surface. */

import { describe, expect, spyOn, test } from 'bun:test'
import packageJson from '../package.json' with { type: 'json' }
import rootPackageJson from '../../package.json' with { type: 'json' }
import { cliVersion, helpText, parseCommandSyntax } from './cli.ts'
import { runCli, type RunCliDependencies } from './index.ts'
import type { CommandSyntaxRunConfig, CommandSyntaxServeConfig } from './agent/types.ts'
import { providerRuntimeError } from './provider-runtime/types.ts'
import type { CommandOutcome, ProviderManagerIO, ProviderRuntime } from './provider-runtime/types.ts'
import type { Api, Model } from '@earendil-works/pi-ai'

test('cliVersion and the CLI package match the released app version', () => {
  expect(cliVersion).toBe(packageJson.version)
  expect(packageJson.version).toBe(rootPackageJson.version)
})

type DispatchProbe = {
  readonly dependencies: RunCliDependencies
  readonly runtimeCreations: () => number
  readonly runConfigurations: readonly CommandSyntaxRunConfig[]
  readonly serveConfigurations: readonly CommandSyntaxServeConfig[]
  readonly managerModes: readonly string[]
  readonly managerIOs: readonly ProviderManagerIO[]
  readonly persistedCommands: readonly Parameters<ProviderRuntime['manage']>[0][]
  readonly preparedSelections: readonly Parameters<ProviderRuntime['prepare']>[0][]
  readonly bindingDisposals: () => number
  readonly errors: readonly string[]
  readonly exitCodes: readonly number[]
  readonly bridgeCalls: () => number
  readonly irohBridgeConfigurations: readonly Parameters<RunCliDependencies['runIrohBridge']>[0][]
  readonly connectConfigurations: readonly Parameters<RunCliDependencies['runIrohConnect']>[0][]
  readonly irohAdminActions: readonly Parameters<RunCliDependencies['runIrohAdmin']>[0][]
}

/** Builds an isolated entrypoint seam so dispatch tests never open a terminal or network connection. */
const dispatchProbe = (outcome: CommandOutcome = { kind: 'handled' }): DispatchProbe => {
  let runtimeCreations = 0
  let bridgeCalls = 0
  const runConfigurations: CommandSyntaxRunConfig[] = []
  const serveConfigurations: CommandSyntaxServeConfig[] = []
  const managerModes: string[] = []
  const managerIOs: ProviderManagerIO[] = []
  const persistedCommands: Parameters<ProviderRuntime['manage']>[0][] = []
  const preparedSelections: Parameters<ProviderRuntime['prepare']>[0][] = []
  let bindingDisposals = 0
  const errors: string[] = []
  const exitCodes: number[] = []
  const irohBridgeConfigurations: Parameters<RunCliDependencies['runIrohBridge']>[0][] = []
  const connectConfigurations: Parameters<RunCliDependencies['runIrohConnect']>[0][] = []
  const irohAdminActions: Parameters<RunCliDependencies['runIrohAdmin']>[0][] = []
  const snapshot: ProviderRuntime['snapshot'] = () => ({
    revision: 0,
    activeProviderId: null,
    thunderbolt: { status: 'not authenticated', defaultModelId: 'managed-default' },
    providers: [],
  })
  const runtime: ProviderRuntime = {
    snapshot,
    manage: async (command) => {
      persistedCommands.push(command)
      return snapshot()
    },
    prepare: async (selection) => {
      preparedSelections.push(selection)
      return {
        providerId: selection.providerId ?? 'thunderbolt',
        wireModel: selection.model ?? 'model',
        persistsCredentialStatus: true,
        piModel: { provider: selection.providerId ?? 'thunderbolt', id: selection.model ?? 'model' } as Model<Api>,
        install: () => {},
        attach: () => () => {},
        observePromptError: async () => {},
        dispose: async () => {
          bindingDisposals += 1
        },
      }
    },
  }
  const managerIO: ProviderManagerIO = {
    choose: async () => null,
    readText: async () => null,
    readSecret: async () => null,
    write: () => {},
    showVerification: () => {},
    showStatus: () => {},
  }

  const dependencies: RunCliDependencies = {
    parseCommandSyntax: (argv) => parseCommandSyntax(argv, '/repo'),
    createProviderRuntime: async () => {
      runtimeCreations += 1
      return runtime
    },
    runAgent: async (config, suppliedRuntime) => {
      expect(suppliedRuntime).toBe(runtime)
      runConfigurations.push(config)
    },
    runAcpServe: async (config, suppliedRuntime) => {
      expect(suppliedRuntime).toBe(runtime)
      serveConfigurations.push(config)
    },
    runBridge: async () => {
      bridgeCalls += 1
    },
    runIrohBridge: async (config) => {
      irohBridgeConfigurations.push(config)
    },
    runIrohConnect: async (config) => {
      connectConfigurations.push(config)
    },
    runIrohAdmin: async (action) => {
      irohAdminActions.push(action)
    },
    createTerminalIO: () => ({
      isTTY: false,
      readLine: async () => null,
      readSecret: async () => null,
      write: () => {},
      ask: async () => 'deny',
      close: () => {},
      signal: new AbortController().signal,
    }),
    createPlainProviderManagerIO: () => managerIO,
    runProviderManager: async (io, suppliedRuntime, mode) => {
      expect(suppliedRuntime).toBe(runtime)
      managerIOs.push(io)
      managerModes.push(mode)
      return outcome
    },
    log: () => {},
    writeError: (text) => errors.push(text),
    setExitCode: (code) => exitCodes.push(code),
  }

  return {
    dependencies,
    runtimeCreations: () => runtimeCreations,
    runConfigurations,
    serveConfigurations,
    managerModes,
    managerIOs,
    persistedCommands,
    preparedSelections,
    bindingDisposals: () => bindingDisposals,
    errors,
    exitCodes,
    bridgeCalls: () => bridgeCalls,
    irohBridgeConfigurations,
    connectConfigurations,
    irohAdminActions,
  }
}

describe('runCli provider-runtime dispatch', () => {
  test('creates one runtime and passes it to the syntactic direct run', async () => {
    const probe = dispatchProbe()

    await runCli(['summarize', 'the', 'diff'], probe.dependencies)

    expect(probe.runtimeCreations()).toBe(1)
    expect(probe.runConfigurations).toEqual([
      {
        cwd: '/repo',
        yolo: false,
        fullscreen: false,
        thinking: 'medium',
        selection: {},
        mode: 'oneshot',
        prompt: 'summarize the diff',
      },
    ])
  })

  test('creates one runtime and passes it to ACP serve', async () => {
    const probe = dispatchProbe()

    await runCli(['acp', 'serve', '--provider', 'work', '--model', 'custom'], probe.dependencies)

    expect(probe.runtimeCreations()).toBe(1)
    expect(probe.serveConfigurations).toEqual([
      {
        cwd: '/repo',
        yolo: false,
        thinking: 'medium',
        selection: { providerId: 'work', model: 'custom' },
      },
    ])
  })

  test('routes standalone login through plain provider management and persists its deferred switch once', async () => {
    const persist = { type: 'use' as const, providerId: 'thunderbolt' }
    const probe = dispatchProbe({
      kind: 'switch',
      selection: { providerId: 'thunderbolt' },
      persist,
      forceReplace: true,
    })

    await runCli(['login'], probe.dependencies)

    expect(probe.runtimeCreations()).toBe(1)
    expect(probe.managerModes).toEqual(['login'])
    expect(probe.managerIOs).toHaveLength(1)
    expect(probe.persistedCommands).toEqual([persist])
    expect(probe.preparedSelections).toEqual([{ providerId: 'thunderbolt' }])
    expect(probe.bindingDisposals()).toBe(1)
  })

  test('routes standalone logout through plain provider management and persists deactivation once', async () => {
    const persist = { type: 'clear-active' as const }
    const probe = dispatchProbe({ kind: 'deactivate', persist })

    await runCli(['logout'], probe.dependencies)

    expect(probe.runtimeCreations()).toBe(1)
    expect(probe.managerModes).toEqual(['logout'])
    expect(probe.managerIOs).toHaveLength(1)
    expect(probe.persistedCommands).toEqual([persist])
    expect(probe.preparedSelections).toEqual([])
    expect(probe.bindingDisposals()).toBe(0)
  })

  test('standalone logout persists deactivation then exits nonzero for confirmed remote logout persistence failure', async () => {
    const failure = Object.assign(providerRuntimeError('persistence-failed', 'local auth clear failed'), {
      remoteLogoutConfirmed: true as const,
    })
    const persist = { type: 'clear-active' as const }
    const probe = dispatchProbe({ kind: 'deactivate', persist, failure })

    await runCli(['logout'], probe.dependencies)

    expect(probe.persistedCommands).toEqual([persist])
    expect(probe.errors).toEqual(['thunderbolt: local auth clear failed\n'])
    expect(probe.exitCodes).toEqual([1])
  })

  test('routes config through the plain provider manager and applies its deferred switch once', async () => {
    const outcome = {
      kind: 'switch' as const,
      selection: { providerId: 'thunderbolt' },
      persist: { type: 'use' as const, providerId: 'thunderbolt' },
      forceReplace: false,
    }
    const probe = dispatchProbe(outcome)

    await runCli(['config'], probe.dependencies)

    expect(probe.runtimeCreations()).toBe(1)
    expect(probe.managerModes).toEqual(['providers'])
    expect(probe.managerIOs).toHaveLength(1)
    expect(probe.persistedCommands).toEqual([outcome.persist])
    expect(probe.preparedSelections).toEqual([outcome.selection])
    expect(probe.bindingDisposals()).toBe(1)
    expect(probe.runConfigurations).toEqual([])
    expect(probe.serveConfigurations).toEqual([])
  })

  test('routes config through the plain provider manager and applies its deferred deactivation once', async () => {
    const outcome = { kind: 'deactivate' as const, persist: { type: 'clear-active' as const } }
    const probe = dispatchProbe(outcome)

    await runCli(['config'], probe.dependencies)

    expect(probe.runtimeCreations()).toBe(1)
    expect(probe.managerModes).toEqual(['providers'])
    expect(probe.managerIOs).toHaveLength(1)
    expect(probe.persistedCommands).toEqual([outcome.persist])
    expect(probe.preparedSelections).toEqual([])
    expect(probe.runConfigurations).toEqual([])
    expect(probe.serveConfigurations).toEqual([])
  })

  test('leaves bridge dispatch outside provider runtime creation', async () => {
    const probe = dispatchProbe()

    await runCli(['acp', '--transport', 'wss', '--', 'agent'], probe.dependencies)

    expect(probe.runtimeCreations()).toBe(0)
    expect(probe.bridgeCalls()).toBe(1)
  })

  test('leaves Iroh bridge dispatch outside provider runtime creation', async () => {
    const probe = dispatchProbe()

    await runCli(['acp', '--transport', 'iroh', '--', 'agent'], probe.dependencies)

    expect(probe.runtimeCreations()).toBe(0)
    expect(probe.irohBridgeConfigurations).toEqual([
      { protocol: 'acp', transport: 'iroh', port: 8839, command: ['agent'] },
    ])
  })

  test('leaves connect dispatch outside provider runtime creation', async () => {
    const probe = dispatchProbe()

    await runCli(['acp', 'connect', 'ticket123', '--', 'local', 'client'], probe.dependencies)

    expect(probe.runtimeCreations()).toBe(0)
    expect(probe.connectConfigurations).toEqual([
      { protocol: 'acp', target: 'ticket123', command: ['local', 'client'] },
    ])
  })

  test('leaves Iroh admin dispatch outside provider runtime creation', async () => {
    const probe = dispatchProbe()

    await runCli(['iroh', 'allow', 'node-xyz'], probe.dependencies)

    expect(probe.runtimeCreations()).toBe(0)
    expect(probe.irohAdminActions).toEqual([{ kind: 'allow', nodeId: 'node-xyz' }])
  })
})

describe('help contract', () => {
  test('lists the compatibility key flag without putting a key on a command line example', () => {
    expect(helpText).toContain('--api-key <key>')
    const examples = helpText.slice(helpText.indexOf('EXAMPLES'))
    expect(examples).not.toContain('--api-key')
    expect(examples).not.toMatch(/(?:sk-|AIza)[A-Za-z0-9…-]*/)
  })

})

/** Narrow canonical syntax to a `run` config or fail loudly. */
const syntaxRunConfig = (argv: string[], cwd?: string) => {
  const parsed = parseCommandSyntax(argv, cwd)
  if (parsed.kind !== 'run') throw new Error(`expected run, got ${parsed.kind}: ${JSON.stringify(parsed)}`)
  return parsed.config
}

describe('parseCommandSyntax — canonical provider inputs', () => {
  test('omitted run provider inputs stay absent from the canonical config', () => {
    const parsed = parseCommandSyntax([], '/repo')
    if (parsed.kind !== 'run') throw new Error(`expected run, got ${parsed.kind}`)

    expect(parsed.config).toEqual({
      cwd: '/repo',
      yolo: false,
      fullscreen: false,
      thinking: 'medium',
      selection: {},
      mode: 'repl',
      noTui: false,
    })
    expect(parsed.config).not.toHaveProperty('provider')
    expect(parsed.config).not.toHaveProperty('model')
    expect(parsed.config).not.toHaveProperty('apiKey')
    expect(parsed.config).not.toHaveProperty('baseUrl')
  })

  test('explicit run provider inputs exist only in InvocationSelection', () => {
    const parsed = parseCommandSyntax(
      [
        '--provider',
        'work-openai',
        '--model',
        'gpt-custom',
        '--api-key',
        'flag-secret',
        '--base-url',
        'https://models.example/v1',
        '--thinking',
        'high',
        '--yolo',
        'review',
        'this',
      ],
      '/repo',
    )
    if (parsed.kind !== 'run') throw new Error(`expected run, got ${parsed.kind}`)

    expect(parsed.config).toEqual({
      cwd: '/repo',
      yolo: true,
      fullscreen: false,
      thinking: 'high',
      selection: {
        providerId: 'work-openai',
        model: 'gpt-custom',
        apiKey: 'flag-secret',
        baseUrl: 'https://models.example/v1',
      },
      mode: 'oneshot',
      prompt: 'review this',
    })
  })

  test('omitted serve provider inputs stay absent from the canonical config', () => {
    const parsed = parseCommandSyntax(['acp', 'serve'], '/repo')
    if (parsed.kind !== 'acp-serve') throw new Error(`expected acp-serve, got ${parsed.kind}`)

    expect(parsed.config).toEqual({ cwd: '/repo', yolo: false, thinking: 'medium', selection: {} })
    expect(parsed.config).not.toHaveProperty('provider')
    expect(parsed.config).not.toHaveProperty('model')
    expect(parsed.config).not.toHaveProperty('apiKey')
    expect(parsed.config).not.toHaveProperty('baseUrl')
  })

  test('explicit serve provider inputs exist only in InvocationSelection', () => {
    const parsed = parseCommandSyntax(
      [
        'acp',
        'serve',
        '--provider',
        'team-anthropic',
        '--model',
        'claude-custom',
        '--api-key',
        'flag-secret',
        '--base-url',
        'https://models.example/v1',
      ],
      '/repo',
    )
    if (parsed.kind !== 'acp-serve') throw new Error(`expected acp-serve, got ${parsed.kind}`)

    expect(parsed.config).toEqual({
      cwd: '/repo',
      yolo: false,
      thinking: 'medium',
      selection: {
        providerId: 'team-anthropic',
        model: 'claude-custom',
        apiKey: 'flag-secret',
        baseUrl: 'https://models.example/v1',
      },
    })
  })
})

describe('parseCommandSyntax — syntactic invocation selection', () => {
  test('does not leak the api key into the prompt', () => {
    const config = syntaxRunConfig(['fix', '--api-key', 'super-secret', 'the', 'bug'])
    if (config.mode !== 'oneshot') throw new Error('expected oneshot')

    expect(config.prompt).toBe('fix the bug')
    expect(config.selection.apiKey).toBe('super-secret')
  })

  test('accepts openai-compatible selection without eagerly requiring a model', () => {
    expect(syntaxRunConfig(['--provider', 'openai-compat', '--base-url', 'https://h/v1']).selection).toEqual({
      providerId: 'openai-compat',
      baseUrl: 'https://h/v1',
    })
  })

  test('the -m alias stores the same model override as --model', () => {
    expect(syntaxRunConfig(['-m', 'custom-model']).selection).toEqual({ model: 'custom-model' })
  })
})

describe('parseCommandSyntax — validation and local run flags', () => {
  test('reports the specific missing-value message for every value-taking flag', () => {
    expect(parseCommandSyntax(['--provider'])).toEqual({
      kind: 'error',
      message: 'thunderbolt: --provider requires a value',
    })
    expect(parseCommandSyntax(['--model'])).toEqual({
      kind: 'error',
      message: 'thunderbolt: --model requires a value',
    })
    expect(parseCommandSyntax(['--base-url'])).toEqual({
      kind: 'error',
      message: 'thunderbolt: --base-url requires a value',
    })
    expect(parseCommandSyntax(['--api-key'])).toEqual({
      kind: 'error',
      message: 'thunderbolt: --api-key requires a value',
    })
    expect(parseCommandSyntax(['--thinking'])).toEqual({
      kind: 'error',
      message: 'thunderbolt: --thinking requires a value',
    })
  })

  test('rejects an invalid thinking level', () => {
    expect(parseCommandSyntax(['--thinking', 'ultra'])).toEqual({
      kind: 'error',
      message: expect.stringContaining("invalid --thinking level 'ultra'"),
    })
  })

  test('threads local harness flags through without putting them in selection', () => {
    const config = syntaxRunConfig(['--thinking', 'high', '--yolo', '--no-tui', '--fullscreen'])

    expect(config.thinking).toBe('high')
    expect(config.yolo).toBe(true)
    expect(config).toHaveProperty('fullscreen', true)
    expect(config.selection).toEqual({})
    if (config.mode !== 'repl') throw new Error('expected repl')
    expect(config.noTui).toBe(true)
  })

  test('preserves every yolo alias', () => {
    expect(syntaxRunConfig(['-y']).yolo).toBe(true)
    expect(syntaxRunConfig(['--yolo']).yolo).toBe(true)
    expect(syntaxRunConfig(['--dangerously-skip-permissions']).yolo).toBe(true)
    expect(syntaxRunConfig([]).yolo).toBe(false)
  })

  test('no-tui defaults to false for a repl', () => {
    const config = syntaxRunConfig([])
    if (config.mode !== 'repl') throw new Error('expected repl')
    expect(config.noTui).toBe(false)
    expect(config).toHaveProperty('fullscreen', false)
  })

  test('--help and --version short-circuit over a run', () => {
    expect(parseCommandSyntax(['--help', 'ignored']).kind).toBe('help')
    expect(parseCommandSyntax(['-h']).kind).toBe('help')
    expect(parseCommandSyntax(['--version']).kind).toBe('version')
    expect(parseCommandSyntax(['-v']).kind).toBe('version')
  })
})

describe('parseCommandSyntax — primary command and agent alias', () => {
  test('a prompt on the primary command is a one-shot run', () => {
    const config = syntaxRunConfig(['do', 'it'])
    if (config.mode !== 'oneshot') throw new Error('expected oneshot')
    expect(config.prompt).toBe('do it')
  })

  test('agent is an exact compatibility alias for the primary command', () => {
    const args = ['--provider', 'profile-id', '--model', 'model-id', 'do', 'it']
    expect(parseCommandSyntax(['agent', ...args])).toEqual(parseCommandSyntax(args))
  })
})

describe('parseCommandSyntax — account and config subcommands', () => {
  test('routes login and logout actions', () => {
    expect(parseCommandSyntax(['login'])).toEqual({ kind: 'login' })
    expect(parseCommandSyntax(['logout'])).toEqual({ kind: 'logout' })
  })

  test('login and logout help short-circuit and stray arguments fail', () => {
    expect(parseCommandSyntax(['login', '--help']).kind).toBe('help')
    expect(parseCommandSyntax(['logout', '-h']).kind).toBe('help')
    expect(parseCommandSyntax(['login', 'extra'])).toEqual({
      kind: 'error',
      message: "thunderbolt login: unexpected argument 'extra'",
    })
    expect(parseCommandSyntax(['logout', 'extra'])).toEqual({
      kind: 'error',
      message: "thunderbolt logout: unexpected argument 'extra'",
    })
  })

  test('account actions do not resolve the current working directory', () => {
    const cwd = spyOn(process, 'cwd').mockImplementation(() => {
      throw new Error('cwd is unavailable')
    })
    try {
      expect(parseCommandSyntax(['login'])).toEqual({ kind: 'login' })
      expect(parseCommandSyntax(['logout'])).toEqual({ kind: 'logout' })
    } finally {
      cwd.mockRestore()
    }
  })

  test('routes config and rejects extra arguments', () => {
    expect(parseCommandSyntax(['config'])).toEqual({ kind: 'config' })
    expect(parseCommandSyntax(['config', 'extra'])).toEqual({
      kind: 'error',
      message: "thunderbolt config: unexpected argument 'extra'",
    })
  })
})

describe('parseCommandSyntax — external bridge compatibility', () => {
  test('keeps wss bridge parsing unchanged', () => {
    expect(parseCommandSyntax(['acp', '--transport', 'wss', '--port', '9001', '--', 'npx', 'agent'])).toEqual({
      kind: 'bridge',
      config: { protocol: 'acp', transport: 'wss', port: 9001, command: ['npx', 'agent'] },
    })
  })

  test('keeps iroh bridge parsing unchanged', () => {
    expect(parseCommandSyntax(['mcp', '--transport', 'iroh', '--', 'bunx', 'server'])).toEqual({
      kind: 'bridge',
      config: { protocol: 'mcp', transport: 'iroh', port: 8840, command: ['bunx', 'server'] },
    })
  })

  test('keeps protocol-specific default ports unchanged', () => {
    const acp = parseCommandSyntax(['acp', '--', 'cmd'])
    const mcp = parseCommandSyntax(['mcp', '--', 'cmd'])
    if (acp.kind !== 'bridge' || mcp.kind !== 'bridge') throw new Error('expected bridge')

    expect(acp.config.port).toBe(8839)
    expect(mcp.config.port).toBe(8840)
  })

  test('keeps connect parsing unchanged', () => {
    expect(parseCommandSyntax(['acp', 'connect', 'ticket123', '--', 'local', 'client'])).toEqual({
      kind: 'connect',
      config: { protocol: 'acp', target: 'ticket123', command: ['local', 'client'] },
    })
    expect(parseCommandSyntax(['mcp', 'connect', 'node-abc'])).toEqual({
      kind: 'connect',
      config: { protocol: 'mcp', target: 'node-abc', command: [] },
    })
  })

  test('keeps help in the post-separator connect command', () => {
    expect(parseCommandSyntax(['acp', 'connect', 'ticket123', '--', 'client', '--help'])).toEqual({
      kind: 'connect',
      config: { protocol: 'acp', target: 'ticket123', command: ['client', '--help'] },
    })
  })

  test('preserves bridge validation', () => {
    expect(parseCommandSyntax(['acp', '--transport', 'tcp', '--', 'cmd'])).toEqual({
      kind: 'error',
      message: expect.stringContaining("invalid --transport 'tcp'"),
    })
    expect(parseCommandSyntax(['acp', '--port', '70000', '--', 'cmd']).kind).toBe('error')
    expect(parseCommandSyntax(['acp', '--port', '0x10', '--', 'cmd']).kind).toBe('error')
    expect(parseCommandSyntax(['acp', '--port', '1e3', '--', 'cmd']).kind).toBe('error')
    expect(parseCommandSyntax(['acp', 'npx', 'agent'])).toEqual({
      kind: 'error',
      message: expect.stringContaining("forget '--'"),
    })
    expect(parseCommandSyntax(['mcp', '--transport', 'wss', '--'])).toEqual({
      kind: 'error',
      message: expect.stringContaining('missing agent command'),
    })
    expect(parseCommandSyntax(['acp']).kind).toBe('error')
  })

  test('preserves connect validation', () => {
    expect(parseCommandSyntax(['mcp', 'connect']).kind).toBe('error')
    expect(parseCommandSyntax(['acp', 'connect', 'ticket', 'stray'])).toEqual({
      kind: 'error',
      message: expect.stringContaining("unexpected argument 'stray'"),
    })
  })
})

describe('parseCommandSyntax — acp serve', () => {
  test('version aliases short-circuit', () => {
    expect(parseCommandSyntax(['acp', 'serve', '--version'])).toEqual({ kind: 'version' })
    expect(parseCommandSyntax(['acp', 'serve', '-v'])).toEqual({ kind: 'version' })
  })

  test('rejects a positional prompt', () => {
    expect(parseCommandSyntax(['acp', 'serve', 'unexpected'])).toEqual({
      kind: 'error',
      message: "thunderbolt acp serve: unexpected argument 'unexpected'",
    })
  })
})

describe('parseCommandSyntax — iroh admin', () => {
  test('routes id, pair, and allow without changing their shapes', () => {
    expect(parseCommandSyntax(['iroh', 'id'])).toEqual({ kind: 'iroh-admin', action: { kind: 'id' } })
    expect(parseCommandSyntax(['iroh', 'pair'])).toEqual({ kind: 'iroh-admin', action: { kind: 'pair' } })
    expect(parseCommandSyntax(['iroh', 'allow', 'node-xyz'])).toEqual({
      kind: 'iroh-admin',
      action: { kind: 'allow', nodeId: 'node-xyz' },
    })
  })

  test('preserves iroh admin validation', () => {
    expect(parseCommandSyntax(['iroh', 'allow']).kind).toBe('error')
    expect(parseCommandSyntax(['iroh', 'bogus']).kind).toBe('error')
  })
})
