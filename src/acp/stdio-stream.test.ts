import { describe, expect, mock, test } from 'bun:test'
import { createStdioStream, isAgentAvailable, type SubprocessHandle, type SubprocessSpawner } from './stdio-stream'

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
