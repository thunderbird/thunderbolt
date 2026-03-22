import { describe, expect, mock, test } from 'bun:test'
import { connectToLocalAgent } from './local-agent'
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
})
