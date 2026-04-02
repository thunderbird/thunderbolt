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

    expect(spawner.spawn).toHaveBeenCalledWith('claude', ['--acp'])
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

    expect(spawner.spawn).toHaveBeenCalledWith('claude', [])
  })

  test('spawns NPX agent via node command', async () => {
    const spawner = createMockSpawner()
    const npxConfig: AgentConfig & Record<string, any> = {
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
    const uvxConfig: AgentConfig & Record<string, any> = {
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

  test('spawns custom agent directly', async () => {
    const spawner = createMockSpawner()
    const customConfig: AgentConfig & Record<string, any> = {
      ...testAgentConfig,
      command: '/usr/local/bin/my-agent',
      args: ['--verbose'],
      distributionType: 'custom',
    }

    await connectToLocalAgent({ agentConfig: customConfig, spawner })

    expect(spawner.spawn).toHaveBeenCalledWith('/usr/local/bin/my-agent', ['--verbose'])
  })
})

describe('resolveSpawnCommand', () => {
  test('uses node for NPX-installed agents', () => {
    const config: AgentConfig & Record<string, any> = {
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
    const config: AgentConfig & Record<string, any> = {
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

  test('falls back to direct command for NPX without installPath', () => {
    const config: AgentConfig & Record<string, any> = {
      ...testAgentConfig,
      command: 'some-agent',
      distributionType: 'npx',
    }
    const result = resolveSpawnCommand(config)
    expect(result.command).toBe('some-agent')
  })

  test('falls back to direct command for UVX without packageName', () => {
    const config: AgentConfig & Record<string, any> = {
      ...testAgentConfig,
      command: 'some-agent',
      distributionType: 'uvx',
    }
    const result = resolveSpawnCommand(config)
    expect(result.command).toBe('some-agent')
  })

  test('throws when command is missing', () => {
    const config: AgentConfig = { ...testAgentConfig, command: undefined }
    expect(() => resolveSpawnCommand(config)).toThrow('no command configured')
  })
})
