import { describe, expect, mock, test } from 'bun:test'
import { connectToRemoteAgent } from './remote-agent'
import { wsOpen, type WebSocketLike } from './websocket-stream'
import type { AgentConfig } from './types'
import type { Stream } from '@agentclientprotocol/sdk'

const createMockWebSocket = (
  autoConnect = true,
): WebSocketLike & { _trigger: (event: string, data?: unknown) => void } => {
  const listeners = new Map<string, Set<Function>>()

  const ws: WebSocketLike & { _trigger: (event: string, data?: unknown) => void } = {
    readyState: autoConnect ? wsOpen : 0,
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
  test('calls onStream with a stream when WebSocket opens', () => {
    const streams: Stream[] = []
    const onDisconnected = mock(() => {})

    const ws = createMockWebSocket(false)
    connectToRemoteAgent({
      agentConfig: testRemoteAgent,
      createWebSocket: () => {
        // Auto-open on next microtask
        queueMicrotask(() => ws._trigger('open'))
        return ws
      },
      onStream: (stream) => {
        streams.push(stream)
      },
      onDisconnected,
    })

    // Trigger open synchronously to ensure onStream fires
    ws._trigger('open')

    expect(streams).toHaveLength(1)
    expect(streams[0].readable).toBeInstanceOf(ReadableStream)
    expect(streams[0].writable).toBeInstanceOf(WritableStream)
    expect(onDisconnected).not.toHaveBeenCalled()
  })

  test('disconnect closes the WebSocket', () => {
    const ws = createMockWebSocket(false)
    const { disconnect } = connectToRemoteAgent({
      agentConfig: testRemoteAgent,
      createWebSocket: () => ws,
      onStream: () => {},
      onDisconnected: () => {},
    })

    ws._trigger('open')
    disconnect()
    expect(ws.close).toHaveBeenCalled()
  })

  test('throws synchronously when agent has no URL', () => {
    const noUrlConfig: AgentConfig = {
      ...testRemoteAgent,
      url: undefined,
    }

    expect(() =>
      connectToRemoteAgent({
        agentConfig: noUrlConfig,
        createWebSocket: () => createMockWebSocket(true),
        onStream: () => {},
        onDisconnected: () => {},
      }),
    ).toThrow('has no URL configured')
  })

  test('calls onStream again on reconnect after unexpected close', () => {
    const sockets: ReturnType<typeof createMockWebSocket>[] = []
    const streams: Stream[] = []

    connectToRemoteAgent({
      agentConfig: testRemoteAgent,
      createWebSocket: () => {
        const ws = createMockWebSocket(false)
        sockets.push(ws)
        return ws
      },
      onStream: (stream) => {
        streams.push(stream)
      },
      onDisconnected: () => {},
    })

    // First connection
    sockets[0]._trigger('open')
    expect(streams).toHaveLength(1)
  })
})
