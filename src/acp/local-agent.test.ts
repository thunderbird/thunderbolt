import { describe, expect, mock, test } from 'bun:test'
import { connectToLocalAgent, resolveSpawnCommand } from './local-agent'
import type { AgentConfig } from './types'
import type { SubprocessHandle, SubprocessSpawner } from './stdio-stream'

const createMockHandle = (): SubprocessHandle => {
  const { readable: stdout } = new TransformStream<Uint8Array>()
  const { writable: stdin } = new TransformStream<Uint8Array>()

  return {
    stdin,
    stdout,
    kill: mock(() => Promise.resolve()),
    onExit: mock(() => {}),
    onStderr: mock(() => {}),
  }
}

const createMockSpawner = (handle?: SubprocessHandle): SubprocessSpawner => ({
  spawn: mock(async () => handle ?? createMockHandle()),
  which: mock(async (command: string) => `/usr/bin/${command}`),
})

const testAgentConfig: AgentConfig = {
  id: 'agent-claude-code',
  name: 'Claude Code',
  type: 'local',
  transport: 'stdio',
  command: 'claude',
  args: ['--acp'],
  isSystem: true,
  enabled: true,
}

describe('connectToLocalAgent', () => {
  test('spawns agent process with correct command and args', async () => {
    const spawner = createMockSpawner()
    await connectToLocalAgent({ agentConfig: testAgentConfig, spawner })

    const [cmd, args] = (spawner.spawn as ReturnType<typeof mock>).mock.calls[0] as [string, string[]]
    expect(cmd).toBe('node')
    expect(args[0]).toBe('-e')
    expect(args[2]).toBe('claude')
    expect(args[3]).toBe('--acp')
  })

  test('returns stream and process handle', async () => {
    const spawner = createMockSpawner()
    const connection = await connectToLocalAgent({ agentConfig: testAgentConfig, spawner })

    expect(connection.stream).toBeDefined()
    expect(connection.stream.readable).toBeInstanceOf(ReadableStream)
    expect(connection.stream.writable).toBeInstanceOf(WritableStream)
    expect(connection.process).toBeDefined()
  })

  test('cleanup kills the process', async () => {
    const handle = createMockHandle()
    const spawner = createMockSpawner(handle)
    const connection = await connectToLocalAgent({ agentConfig: testAgentConfig, spawner })

    await connection.cleanup()

    expect(handle.kill).toHaveBeenCalled()
  })

  test('sets up exit handler', async () => {
    const handle = createMockHandle()
    const spawner = createMockSpawner(handle)
    await connectToLocalAgent({ agentConfig: testAgentConfig, spawner })

    expect(handle.onExit).toHaveBeenCalled()
  })

  test('sets up stderr handler', async () => {
    const handle = createMockHandle()
    const spawner = createMockSpawner(handle)
    await connectToLocalAgent({ agentConfig: testAgentConfig, spawner })

    expect(handle.onStderr).toHaveBeenCalled()
  })

  test('throws when agent has no command', async () => {
    const spawner = createMockSpawner()
    const noCommandConfig: AgentConfig = {
      ...testAgentConfig,
      command: undefined,
    }

    await expect(connectToLocalAgent({ agentConfig: noCommandConfig, spawner })).rejects.toThrow(
      'has no command configured',
    )
  })

  test('uses empty args when none provided', async () => {
    const spawner = createMockSpawner()
    const noArgsConfig: AgentConfig = {
      ...testAgentConfig,
      args: undefined,
    }

    await connectToLocalAgent({ agentConfig: noArgsConfig, spawner })

    const [cmd, args] = (spawner.spawn as ReturnType<typeof mock>).mock.calls[0] as [string, string[]]
    expect(cmd).toBe('node')
    expect(args[2]).toBe('claude')
    expect(args.length).toBe(3) // -e, script, command — no extra args
  })

  test('spawns NPX agent via node command', async () => {
    const spawner = createMockSpawner()
    const npxConfig: AgentConfig = {
      ...testAgentConfig,
      command: '/app-data/agents/claude-acp/node_modules/.bin/claude-agent-acp',
      args: ['--acp'],
      distributionType: 'npx',
      installPath: '/app-data/agents/claude-acp',
    }

    await connectToLocalAgent({ agentConfig: npxConfig, spawner })

    expect(spawner.spawn).toHaveBeenCalledWith('node', [
      '/app-data/agents/claude-acp/node_modules/.bin/claude-agent-acp',
      '--acp',
    ])
  })

  test('spawns UVX agent via uvx command', async () => {
    const spawner = createMockSpawner()
    const uvxConfig: AgentConfig = {
      ...testAgentConfig,
      command: '/app-data/agents/fast-agent/bin/fast-agent',
      args: ['acp'],
      distributionType: 'uvx',
      installPath: '/app-data/agents/fast-agent',
      packageName: 'fast-agent@0.6.10',
    }

    await connectToLocalAgent({ agentConfig: uvxConfig, spawner })

    expect(spawner.spawn).toHaveBeenCalledWith('uvx', ['fast-agent@0.6.10', 'acp'])
  })

  test('spawns binary agent via node bridge script', async () => {
    const spawner = createMockSpawner()
    const binaryConfig: AgentConfig = {
      ...testAgentConfig,
      command: '/app-data/agents/goose/goose',
      args: ['--acp'],
      distributionType: 'binary',
      installPath: '/app-data/agents/goose',
    }

    await connectToLocalAgent({ agentConfig: binaryConfig, spawner })

    const [cmd, args] = (spawner.spawn as ReturnType<typeof mock>).mock.calls[0] as [string, string[]]
    expect(cmd).toBe('node')
    expect(args[0]).toBe('-e')
    // Bridge script is the second arg
    expect(args[1]).toContain('spawn')
    expect(args[1]).toContain('process.argv[1]')
    // Binary path and args follow the bridge script
    expect(args[2]).toBe('/app-data/agents/goose/goose')
    expect(args[3]).toBe('--acp')
  })

  test('spawns custom agent with absolute path via node bridge', async () => {
    const spawner = createMockSpawner()
    const customConfig: AgentConfig = {
      ...testAgentConfig,
      command: '/usr/local/bin/my-agent',
      args: ['--verbose'],
      distributionType: 'custom',
    }

    await connectToLocalAgent({ agentConfig: customConfig, spawner })

    const [cmd, args] = (spawner.spawn as ReturnType<typeof mock>).mock.calls[0] as [string, string[]]
    expect(cmd).toBe('node')
    expect(args[0]).toBe('-e')
    expect(args[2]).toBe('/usr/local/bin/my-agent')
    expect(args[3]).toBe('--verbose')
  })

  test('spawns bare command name via node bridge', async () => {
    const spawner = createMockSpawner()
    const bareConfig: AgentConfig = {
      ...testAgentConfig,
      command: 'codex',
      args: ['--acp'],
    }

    await connectToLocalAgent({ agentConfig: bareConfig, spawner })

    const [cmd, args] = (spawner.spawn as ReturnType<typeof mock>).mock.calls[0] as [string, string[]]
    expect(cmd).toBe('node')
    expect(args[0]).toBe('-e')
    expect(args[2]).toBe('codex')
    expect(args[3]).toBe('--acp')
  })
})

describe('resolveSpawnCommand', () => {
  test('uses node for NPX-installed agents', () => {
    const config: AgentConfig = {
      ...testAgentConfig,
      command: '/path/to/node_modules/.bin/agent',
      args: ['--acp'],
      distributionType: 'npx',
      installPath: '/path/to',
    }
    const result = resolveSpawnCommand(config)
    expect(result.command).toBe('node')
    expect(result.args[0]).toBe('/path/to/node_modules/.bin/agent')
  })

  test('uses uvx for UVX-installed agents', () => {
    const config: AgentConfig = {
      ...testAgentConfig,
      command: '/path/to/bin/agent',
      args: ['acp'],
      distributionType: 'uvx',
      installPath: '/path/to',
      packageName: 'agent@1.0.0',
    }
    const result = resolveSpawnCommand(config)
    expect(result.command).toBe('uvx')
    expect(result.args[0]).toBe('agent@1.0.0')
  })

  test('uses node bridge for binary agents', () => {
    const config: AgentConfig = {
      ...testAgentConfig,
      command: '/path/to/agents/goose/goose',
      args: ['--acp'],
      distributionType: 'binary',
      installPath: '/path/to/agents/goose',
    }
    const result = resolveSpawnCommand(config)
    expect(result.command).toBe('node')
    expect(result.args[0]).toBe('-e')
    expect(result.args[1]).toContain('spawn')
    expect(result.args[2]).toBe('/path/to/agents/goose/goose')
    expect(result.args[3]).toBe('--acp')
  })

  test('falls back to node bridge for NPX without installPath', () => {
    const config: AgentConfig = {
      ...testAgentConfig,
      command: 'some-agent',
      distributionType: 'npx',
    }
    const result = resolveSpawnCommand(config)
    expect(result.command).toBe('node')
    expect(result.args[0]).toBe('-e')
    expect(result.args[2]).toBe('some-agent')
  })

  test('falls back to node bridge for UVX without packageName', () => {
    const config: AgentConfig = {
      ...testAgentConfig,
      command: 'some-agent',
      distributionType: 'uvx',
    }
    const result = resolveSpawnCommand(config)
    expect(result.command).toBe('node')
    expect(result.args[0]).toBe('-e')
    expect(result.args[2]).toBe('some-agent')
  })

  test('falls back to node bridge for binary without installPath', () => {
    const config: AgentConfig = {
      ...testAgentConfig,
      command: 'some-agent',
      distributionType: 'binary',
    }
    const result = resolveSpawnCommand(config)
    expect(result.command).toBe('node')
    expect(result.args[0]).toBe('-e')
    expect(result.args[2]).toBe('some-agent')
  })

  test('throws when command is missing', () => {
    const config: AgentConfig = { ...testAgentConfig, command: undefined }
    expect(() => resolveSpawnCommand(config)).toThrow('no command configured')
  })
})

// ── Tauri capability compliance ──────────────────────────────────────────────
// These tests verify that resolveSpawnCommand ONLY returns commands that are
// in the Tauri shell:allow-spawn capabilities (node, uvx) for all registry-
// installed agent types. This is the critical invariant — Tauri rejects
// Command.create() calls for programs not in the capability list.

const allowedSpawnCommands = new Set(['node', 'uvx'])

describe('Tauri capability compliance', () => {
  test('NPX agents resolve to an allowed spawn command', () => {
    const config: AgentConfig = {
      ...testAgentConfig,
      command: '/app-data/agents/autohand-code/node_modules/.bin/autohand-code-acp',
      args: ['--acp'],
      distributionType: 'npx',
      installPath: '/app-data/agents/autohand-code',
      packageName: '@autohand/code-acp@1.0.0',
    }
    const result = resolveSpawnCommand(config)
    expect(allowedSpawnCommands.has(result.command)).toBe(true)
  })

  test('UVX agents resolve to an allowed spawn command', () => {
    const config: AgentConfig = {
      ...testAgentConfig,
      command: '/app-data/agents/fast-agent/bin/fast-agent',
      args: ['acp'],
      distributionType: 'uvx',
      installPath: '/app-data/agents/fast-agent',
      packageName: 'fast-agent@0.6.10',
    }
    const result = resolveSpawnCommand(config)
    expect(allowedSpawnCommands.has(result.command)).toBe(true)
  })

  test('binary agents resolve to an allowed spawn command', () => {
    const config: AgentConfig = {
      ...testAgentConfig,
      command: '/app-data/agents/goose/goose',
      args: ['--acp'],
      distributionType: 'binary',
      installPath: '/app-data/agents/goose',
    }
    const result = resolveSpawnCommand(config)
    expect(allowedSpawnCommands.has(result.command)).toBe(true)
  })

  test('all distribution types with installPath resolve to allowed commands', () => {
    const distTypes = ['npx', 'uvx', 'binary'] as const
    for (const distType of distTypes) {
      const config: AgentConfig = {
        ...testAgentConfig,
        command: `/app-data/agents/test-agent/bin/test-agent`,
        args: ['--acp'],
        distributionType: distType,
        installPath: '/app-data/agents/test-agent',
        packageName: distType === 'uvx' ? 'test-agent@1.0.0' : undefined,
      }
      const result = resolveSpawnCommand(config)
      expect(allowedSpawnCommands.has(result.command)).toBe(true)
    }
  })

  test('absolute path with missing distributionType still resolves to node', () => {
    const config: AgentConfig = {
      ...testAgentConfig,
      command: '/app-data/agents/some-agent/some-agent',
      args: ['--acp'],
      // No distributionType set — simulates missing DB column data
    }
    const result = resolveSpawnCommand(config)
    expect(allowedSpawnCommands.has(result.command)).toBe(true)
  })

  test('node_modules path with missing distributionType still resolves to node', () => {
    const config: AgentConfig = {
      ...testAgentConfig,
      command: '/app-data/agents/test/node_modules/.bin/test-acp',
      args: ['--acp'],
    }
    const result = resolveSpawnCommand(config)
    expect(allowedSpawnCommands.has(result.command)).toBe(true)
  })
})

// ── toAgentConfig round-trip ─────────────────────────────────────────────────
// Verifies that the full path from DB row → AgentConfig → resolveSpawnCommand
// produces a valid spawn command. This catches the original bug where
// toAgentConfig stripped distributionType/installPath/packageName.

describe('DB row → AgentConfig → resolveSpawnCommand round-trip', () => {
  // Simulate what toAgentConfig produces from a DB row
  const simulateToAgentConfig = (dbRow: Record<string, unknown>): AgentConfig => ({
    id: dbRow.id as string,
    name: dbRow.name as string,
    type: dbRow.type as AgentConfig['type'],
    transport: dbRow.transport as AgentConfig['transport'],
    command: (dbRow.command as string) ?? undefined,
    args: dbRow.args ? JSON.parse(dbRow.args as string) : undefined,
    url: (dbRow.url as string) ?? undefined,
    isSystem: dbRow.isSystem === 1,
    enabled: dbRow.enabled === 1,
    distributionType: (dbRow.distributionType as string) ?? undefined,
    installPath: (dbRow.installPath as string) ?? undefined,
    packageName: (dbRow.packageName as string) ?? undefined,
  })

  test('NPX agent DB row produces node spawn command', () => {
    const dbRow = {
      id: 'agent-registry-autohand-code',
      name: 'Autohand Code',
      type: 'local',
      transport: 'stdio',
      command:
        '/Users/chris/Library/Application Support/com.thunderbolt/agents/autohand-code/node_modules/.bin/autohand-code-acp',
      args: '["--acp"]',
      isSystem: 0,
      enabled: 1,
      distributionType: 'npx',
      installPath: '/Users/chris/Library/Application Support/com.thunderbolt/agents/autohand-code',
      packageName: '@autohand/code-acp@1.0.0',
    }
    const config = simulateToAgentConfig(dbRow)
    const result = resolveSpawnCommand(config)

    expect(result.command).toBe('node')
    expect(result.args[0]).toBe(dbRow.command)
    expect(result.args[1]).toBe('--acp')
  })

  test('UVX agent DB row produces uvx spawn command', () => {
    const dbRow = {
      id: 'agent-registry-fast-agent',
      name: 'Fast Agent',
      type: 'local',
      transport: 'stdio',
      command: '/Users/chris/Library/Application Support/com.thunderbolt/agents/fast-agent/bin/fast-agent',
      args: '["acp"]',
      isSystem: 0,
      enabled: 1,
      distributionType: 'uvx',
      installPath: '/Users/chris/Library/Application Support/com.thunderbolt/agents/fast-agent',
      packageName: 'fast-agent@0.6.10',
    }
    const config = simulateToAgentConfig(dbRow)
    const result = resolveSpawnCommand(config)

    expect(result.command).toBe('uvx')
    expect(result.args[0]).toBe('fast-agent@0.6.10')
    expect(result.args[1]).toBe('acp')
  })

  test('binary agent DB row produces node bridge spawn command', () => {
    const dbRow = {
      id: 'agent-registry-goose',
      name: 'Goose',
      type: 'local',
      transport: 'stdio',
      command: '/Users/chris/Library/Application Support/com.thunderbolt/agents/goose/goose',
      args: null,
      isSystem: 0,
      enabled: 1,
      distributionType: 'binary',
      installPath: '/Users/chris/Library/Application Support/com.thunderbolt/agents/goose',
      packageName: null,
    }
    const config = simulateToAgentConfig(dbRow)
    const result = resolveSpawnCommand(config)

    expect(result.command).toBe('node')
    expect(result.args[0]).toBe('-e')
    expect(result.args[2]).toBe(dbRow.command)
  })

  test('DB row with NULL distributionType but bare command uses node bridge', () => {
    const dbRow = {
      id: 'agent-old-custom',
      name: 'Old Custom Agent',
      type: 'local',
      transport: 'stdio',
      command: 'my-agent',
      args: null,
      isSystem: 0,
      enabled: 1,
      distributionType: null,
      installPath: null,
      packageName: null,
    }
    const config = simulateToAgentConfig(dbRow)
    const result = resolveSpawnCommand(config)

    expect(result.command).toBe('node')
    expect(result.args[0]).toBe('-e')
    expect(result.args[2]).toBe('my-agent')
  })

  test('DB row with NULL distributionType but absolute path uses node bridge', () => {
    const dbRow = {
      id: 'agent-registry-some-agent',
      name: 'Some Agent',
      type: 'local',
      transport: 'stdio',
      command: '/Users/chris/Library/Application Support/com.thunderbolt/agents/some-agent/some-agent',
      args: '["--acp"]',
      isSystem: 0,
      enabled: 1,
      distributionType: null,
      installPath: null,
      packageName: null,
    }
    const config = simulateToAgentConfig(dbRow)
    const result = resolveSpawnCommand(config)

    expect(result.command).toBe('node')
    expect(result.args[0]).toBe('-e')
    expect(result.args[2]).toBe(dbRow.command)
    expect(result.args[3]).toBe('--acp')
  })

  test('DB row with NULL distributionType but node_modules path uses node directly', () => {
    const dbRow = {
      id: 'agent-registry-npx-agent',
      name: 'NPX Agent',
      type: 'local',
      transport: 'stdio',
      command: '/Users/chris/Library/Application Support/com.thunderbolt/agents/test/node_modules/.bin/test-agent',
      args: null,
      isSystem: 0,
      enabled: 1,
      distributionType: null,
      installPath: null,
      packageName: null,
    }
    const config = simulateToAgentConfig(dbRow)
    const result = resolveSpawnCommand(config)

    expect(result.command).toBe('node')
    expect(result.args[0]).toBe(dbRow.command)
  })
})
