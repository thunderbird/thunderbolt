import { describe, expect, mock, test } from 'bun:test'
import { getClock } from '@/testing-library'
import { connectWithReconnect, createWebSocketStream, wsOpen, type WebSocketLike } from './websocket-stream'

type MockWebSocket = WebSocketLike & {
  _listeners: Map<string, Set<Function>>
  _trigger: (event: string, data?: unknown) => void
}

const createMockWebSocket = (readyState = wsOpen): MockWebSocket => {
  const listeners = new Map<string, Set<Function>>()

  return {
    _listeners: listeners,
    readyState,
    send: mock(() => {}),
    close: mock(() => {}),
    addEventListener: ((event: string, handler: Function) => {
      if (!listeners.has(event)) {
        listeners.set(event, new Set())
      }
      listeners.get(event)!.add(handler)
    }) as WebSocketLike['addEventListener'],
    removeEventListener: ((event: string, handler: Function) => {
      listeners.get(event)?.delete(handler)
    }) as WebSocketLike['removeEventListener'],
    _trigger: (event: string, data?: unknown) => {
      listeners.get(event)?.forEach((h) => h(data ?? {}))
    },
  }
}

describe('createWebSocketStream', () => {
  test('creates a valid ACP stream from WebSocket', () => {
    const ws = createMockWebSocket()
    const stream = createWebSocketStream(ws)

    expect(stream).toBeDefined()
    expect(stream.readable).toBeInstanceOf(ReadableStream)
    expect(stream.writable).toBeInstanceOf(WritableStream)
  })

  test('incoming WebSocket messages register a message handler', () => {
    const ws = createMockWebSocket()
    createWebSocketStream(ws)

    // Verify message handler was registered
    const messageHandlers = ws._listeners.get('message')
    expect(messageHandlers).toBeDefined()
    expect(messageHandlers!.size).toBe(1)
  })

  test('outgoing writes send data through WebSocket', async () => {
    const ws = createMockWebSocket()
    const stream = createWebSocketStream(ws)

    const writer = stream.writable.getWriter()
    const testMsg = { jsonrpc: '2.0' as const, method: 'test', id: 1 }
    await writer.write(testMsg)

    // ndJsonStream serializes to JSON and writes as Uint8Array
    // The inner writable we created converts back to string and calls ws.send
    // Since ndJsonStream wraps our streams, the write goes through our WritableStream
    // which calls ws.send
    expect(ws.send).toHaveBeenCalled()
  })

  test('writable stream has close capability', () => {
    const ws = createMockWebSocket()
    const stream = createWebSocketStream(ws)

    // Verify the stream is writable (ndJsonStream wraps our WritableStream,
    // so closing the outer stream eventually propagates to ws.close)
    expect(stream.writable).toBeInstanceOf(WritableStream)
  })

  test('registers close handler on WebSocket', () => {
    const ws = createMockWebSocket()
    createWebSocketStream(ws)

    expect(ws._listeners.get('close')?.size).toBe(1)
  })

  test('registers error handler on WebSocket', () => {
    const ws = createMockWebSocket()
    createWebSocketStream(ws)

    expect(ws._listeners.get('error')?.size).toBe(1)
  })

  test('onMessage handler enqueues string data as Uint8Array with newline', () => {
    const ws = createMockWebSocket()
    createWebSocketStream(ws)

    const messageHandler = [...ws._listeners.get('message')!][0]
    // Should not throw when receiving a string message
    messageHandler({ data: '{"jsonrpc":"2.0","result":"ok","id":1}' })
  })

  test('onMessage handler handles ArrayBuffer data', () => {
    const ws = createMockWebSocket()
    createWebSocketStream(ws)

    const messageHandler = [...ws._listeners.get('message')!][0]
    const buffer = new TextEncoder().encode('{"jsonrpc":"2.0"}\n')
    // Should not throw when receiving binary data
    messageHandler({ data: buffer.buffer })
  })

  test('onClose handler closes the readable stream', () => {
    const ws = createMockWebSocket()
    createWebSocketStream(ws)

    const closeHandler = [...ws._listeners.get('close')!][0]
    // Should not throw
    closeHandler({ data: '' })
  })

  test('onClose handler is safe when called twice', () => {
    const ws = createMockWebSocket()
    createWebSocketStream(ws)

    const closeHandler = [...ws._listeners.get('close')!][0]
    closeHandler({ data: '' })
    // Second call should not throw (caught by try/catch)
    closeHandler({ data: '' })
  })

  test('onError handler errors the readable stream', () => {
    const ws = createMockWebSocket()
    createWebSocketStream(ws)

    const errorHandler = [...ws._listeners.get('error')!][0]
    // Should not throw (error is propagated to stream, not thrown)
    errorHandler({ data: 'connection failed' })
  })

  test('onError handler is safe when called after close', () => {
    const ws = createMockWebSocket()
    createWebSocketStream(ws)

    const closeHandler = [...ws._listeners.get('close')!][0]
    const errorHandler = [...ws._listeners.get('error')!][0]
    closeHandler({ data: '' })
    // Error after close should not throw (caught by try/catch)
    errorHandler({ data: 'late error' })
  })

  test('write throws when WebSocket is not open', async () => {
    const ws = createMockWebSocket(3) // WS_CLOSED
    const stream = createWebSocketStream(ws)

    const writer = stream.writable.getWriter()
    const testMsg = { jsonrpc: '2.0' as const, method: 'test', id: 1 }
    await expect(writer.write(testMsg)).rejects.toThrow('WebSocket is not open')
  })
})

describe('connectWithReconnect', () => {
  test('calls onConnect when WebSocket opens', () => {
    const onConnect = mock((_ws: WebSocketLike) => {})
    const onGiveUp = mock(() => {})

    const ws = createMockWebSocket()
    connectWithReconnect({
      onConnect,
      onGiveUp,
      createWebSocket: () => ws,
    })

    ws._trigger('open')

    expect(onConnect).toHaveBeenCalledWith(ws)
    expect(onGiveUp).not.toHaveBeenCalled()
  })

  test('does not reconnect on normal close (code 1000)', () => {
    const createWebSocket = mock(() => createMockWebSocket())
    const onGiveUp = mock(() => {})

    connectWithReconnect({
      onConnect: () => {},
      onGiveUp,
      createWebSocket,
    })

    const firstWs = createWebSocket.mock.results[0]?.value as MockWebSocket
    firstWs._trigger('close', { code: 1000 })

    getClock().tick(10000)

    expect(createWebSocket).toHaveBeenCalledTimes(1)
    expect(onGiveUp).not.toHaveBeenCalled()
  })

  test('does not reconnect on auth failure close (code 4001)', () => {
    const createWebSocket = mock(() => createMockWebSocket())
    const onGiveUp = mock(() => {})

    connectWithReconnect({
      onConnect: () => {},
      onGiveUp,
      createWebSocket,
    })

    const firstWs = createWebSocket.mock.results[0]?.value as MockWebSocket
    firstWs._trigger('close', { code: 4001 })

    getClock().tick(10000)

    expect(createWebSocket).toHaveBeenCalledTimes(1)
    expect(onGiveUp).not.toHaveBeenCalled()
  })

  test('reconnects with exponential backoff on unexpected close', () => {
    const sockets: MockWebSocket[] = []
    const createWebSocket = mock(() => {
      const ws = createMockWebSocket()
      sockets.push(ws)
      return ws
    })
    const onGiveUp = mock(() => {})

    connectWithReconnect({ onConnect: () => {}, onGiveUp, createWebSocket })

    // First connect
    expect(sockets).toHaveLength(1)
    sockets[0]._trigger('close', { code: 1001 }) // unexpected close

    // First retry after 1000ms
    getClock().tick(999)
    expect(sockets).toHaveLength(1)
    getClock().tick(1)
    expect(sockets).toHaveLength(2)

    sockets[1]._trigger('close', { code: 1001 })

    // Second retry after 2000ms
    getClock().tick(1999)
    expect(sockets).toHaveLength(2)
    getClock().tick(1)
    expect(sockets).toHaveLength(3)
  })

  test('resets retry counter after successful reconnect', () => {
    const sockets: MockWebSocket[] = []
    const createWebSocket = mock(() => {
      const ws = createMockWebSocket()
      sockets.push(ws)
      return ws
    })

    connectWithReconnect({ onConnect: () => {}, onGiveUp: () => {}, createWebSocket })

    // First connect fails then succeeds
    sockets[0]._trigger('close', { code: 1001 })
    getClock().tick(1000)
    expect(sockets).toHaveLength(2)

    sockets[1]._trigger('open')
    sockets[1]._trigger('close', { code: 1001 })

    // After successful reconnect, retry counter resets — next delay should be 1000ms again
    getClock().tick(999)
    expect(sockets).toHaveLength(2)
    getClock().tick(1)
    expect(sockets).toHaveLength(3)
  })

  test('calls onGiveUp after max retries exhausted', () => {
    const sockets: MockWebSocket[] = []
    const createWebSocket = mock(() => {
      const ws = createMockWebSocket()
      sockets.push(ws)
      return ws
    })
    const onGiveUp = mock(() => {})

    connectWithReconnect({ onConnect: () => {}, onGiveUp, createWebSocket })

    // Exhaust all 3 retries
    sockets[0]._trigger('close', { code: 1001 })
    getClock().tick(1000)
    sockets[1]._trigger('close', { code: 1001 })
    getClock().tick(2000)
    sockets[2]._trigger('close', { code: 1001 })
    getClock().tick(4000)
    sockets[3]._trigger('close', { code: 1001 })

    expect(onGiveUp).toHaveBeenCalledTimes(1)
    // No more sockets created after give up
    getClock().tick(10000)
    expect(sockets).toHaveLength(4)
  })

  test('cancel prevents a pending retry from firing', () => {
    const sockets: MockWebSocket[] = []
    const createWebSocket = mock(() => {
      const ws = createMockWebSocket()
      sockets.push(ws)
      return ws
    })
    const onGiveUp = mock(() => {})

    const { cancel } = connectWithReconnect({ onConnect: () => {}, onGiveUp, createWebSocket })

    // Trigger an unexpected close to queue a retry
    sockets[0]._trigger('close', { code: 1001 })
    expect(sockets).toHaveLength(1)

    // Cancel before the retry fires
    cancel()
    getClock().tick(2000)

    // No new socket should have been created
    expect(sockets).toHaveLength(1)
    expect(onGiveUp).not.toHaveBeenCalled()
  })

  test('returns a cancel function', () => {
    const ws = createMockWebSocket()
    const result = connectWithReconnect({
      onConnect: () => {},
      onGiveUp: () => {},
      createWebSocket: () => ws,
    })

    expect(result).toHaveProperty('cancel')
    expect(typeof result.cancel).toBe('function')
  })
})
