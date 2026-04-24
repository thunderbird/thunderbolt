import { describe, expect, test } from 'bun:test'
import { createInProcessStreams } from './streams'

describe('createInProcessStreams', () => {
  test('creates a pair of connected streams', () => {
    const { clientStream, agentStream } = createInProcessStreams()

    expect(clientStream).toBeDefined()
    expect(clientStream.readable).toBeInstanceOf(ReadableStream)
    expect(clientStream.writable).toBeInstanceOf(WritableStream)

    expect(agentStream).toBeDefined()
    expect(agentStream.readable).toBeInstanceOf(ReadableStream)
    expect(agentStream.writable).toBeInstanceOf(WritableStream)
  })

  test('client and agent can exchange messages bidirectionally', async () => {
    const { clientStream, agentStream } = createInProcessStreams()

    const clientWriter = clientStream.writable.getWriter()
    const agentReader = agentStream.readable.getReader()

    const agentWriter = agentStream.writable.getWriter()
    const clientReader = clientStream.readable.getReader()

    // Client → Agent
    const clientMsg = { jsonrpc: '2.0' as const, method: 'test', id: 1 }
    await clientWriter.write(clientMsg)

    const { value: receivedByAgent } = await agentReader.read()
    expect(receivedByAgent).toEqual(clientMsg)

    // Agent → Client
    const agentMsg = { jsonrpc: '2.0' as const, result: 'ok', id: 1 }
    await agentWriter.write(agentMsg)

    const { value: receivedByClient } = await clientReader.read()
    expect(receivedByClient).toEqual(agentMsg)

    // Cleanup
    await clientWriter.close()
    await agentWriter.close()
  })
})
