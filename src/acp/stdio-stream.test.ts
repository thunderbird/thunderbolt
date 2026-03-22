import { describe, expect, mock, test } from 'bun:test'
import {
  createStdioStream,
  discoverLocalAgents,
  isAgentAvailable,
  type SubprocessHandle,
  type SubprocessSpawner,
} from './stdio-stream'

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

const createMockSpawner = (availableCommands: string[]): SubprocessSpawner => ({
  spawn: mock(async () => createMockHandle()),
  which: mock(async (command: string) => (availableCommands.includes(command) ? `/usr/bin/${command}` : null)),
})

describe('createStdioStream', () => {
  test('creates a valid ACP stream from subprocess handle', () => {
    const handle = createMockHandle()
    const stream = createStdioStream(handle)

    expect(stream).toBeDefined()
    expect(stream.readable).toBeInstanceOf(ReadableStream)
    expect(stream.writable).toBeInstanceOf(WritableStream)
  })
})

describe('isAgentAvailable', () => {
  test('returns true when command exists on PATH', async () => {
    const spawner = createMockSpawner(['claude'])
    const available = await isAgentAvailable(spawner, 'claude')
    expect(available).toBe(true)
  })

  test('returns false when command is not found', async () => {
    const spawner = createMockSpawner([])
    const available = await isAgentAvailable(spawner, 'nonexistent')
    expect(available).toBe(false)
  })
})

describe('discoverLocalAgents', () => {
  test('discovers available agents from candidates', async () => {
    const spawner = createMockSpawner(['claude', 'goose'])

    const results = await discoverLocalAgents(spawner, [
      { command: 'claude', name: 'Claude Code' },
      { command: 'codex', name: 'Codex' },
      { command: 'goose', name: 'Goose' },
    ])

    expect(results).toHaveLength(3)
    expect(results[0]).toEqual({ command: 'claude', name: 'Claude Code', available: true })
    expect(results[1]).toEqual({ command: 'codex', name: 'Codex', available: false })
    expect(results[2]).toEqual({ command: 'goose', name: 'Goose', available: true })
  })

  test('returns empty array for empty candidates', async () => {
    const spawner = createMockSpawner([])
    const results = await discoverLocalAgents(spawner, [])
    expect(results).toEqual([])
  })
})
