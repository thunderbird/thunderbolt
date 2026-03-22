import { describe, expect, mock, test } from 'bun:test'
import { connectToRemoteAgent } from './remote-agent'
import { WS_OPEN, type WebSocketLike } from './websocket-stream'
import type { AgentConfig } from './types'

const createMockWebSocket = (
  autoConnect = true,
): WebSocketLike & { _trigger: (event: string, data?: unknown) => void } => {
  const listeners = new Map<string, Set<Function>>()

  const ws: WebSocketLike & { _trigger: (event: string, data?: unknown) => void } = {
    readyState: autoConnect ? WS_OPEN : 0,
    send: mock(() => {}),
    close: mock(() => {}),
    addEventListener: (event: string, handler: Function) => {
      if (!listeners.has(event)) {
        listeners.set(event, new Set())
      }
      listeners.get(event)!.add(handler)
    },
    removeEventListener: (event: string, handler: Function) => {
      listeners.get(event)?.delete(handler)
    },
    _trigger: (event: string, data?: unknown) => {
      listeners.get(event)?.forEach((h) => h(data ?? {}))
    },
  }

  return ws
}

const testRemoteAgent: AgentConfig = {
  id: 'agent-haystack',
  name: 'Haystack Research',
  type: 'remote',
  transport: 'websocket',
  url: 'wss://haystack.example.com/acp',
  isSystem: false,
  enabled: true,
}

describe('connectToRemoteAgent', () => {
  test('connects to WebSocket and returns stream', async () => {
    const ws = createMockWebSocket(true)
    const connection = await connectToRemoteAgent({
      agentConfig: testRemoteAgent,
      createWebSocket: () => ws,
    })

    expect(connection.stream).toBeDefined()
    expect(connection.stream.readable).toBeInstanceOf(ReadableStream)
    expect(connection.stream.writable).toBeInstanceOf(WritableStream)
  })

  test('waits for WebSocket to open when not immediately ready', async () => {
    const ws = createMockWebSocket(false)

    // Schedule the open event before calling connect
    // so it fires while the promise is waiting
    const connectPromise = connectToRemoteAgent({
      agentConfig: testRemoteAgent,
      createWebSocket: () => {
        // Trigger open after listeners are registered (next microtask)
        queueMicrotask(() => {
          ws.readyState = WS_OPEN
          ws._trigger('open')
        })
        return ws
      },
    })

    const connection = await connectPromise
    expect(connection.stream).toBeDefined()
  })

  test('rejects when WebSocket connection fails', async () => {
    const ws = createMockWebSocket(false)

    const connectPromise = connectToRemoteAgent({
      agentConfig: testRemoteAgent,
      createWebSocket: () => {
        queueMicrotask(() => {
          ws._trigger('error', { data: 'Connection refused' })
        })
        return ws
      },
    })

    await expect(connectPromise).rejects.toThrow('Failed to connect')
  })

  test('disconnect closes the WebSocket', async () => {
    const ws = createMockWebSocket(true)
    const connection = await connectToRemoteAgent({
      agentConfig: testRemoteAgent,
      createWebSocket: () => ws,
    })

    connection.disconnect()
    expect(ws.close).toHaveBeenCalled()
  })

  test('throws when agent has no URL', async () => {
    const noUrlConfig: AgentConfig = {
      ...testRemoteAgent,
      url: undefined,
    }

    await expect(
      connectToRemoteAgent({
        agentConfig: noUrlConfig,
        createWebSocket: () => createMockWebSocket(true),
      }),
    ).rejects.toThrow('has no URL configured')
  })
})
