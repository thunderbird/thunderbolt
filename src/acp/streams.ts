import { ndJsonStream, type Stream } from '@agentclientprotocol/sdk'

type StreamPair = {
  clientStream: Stream
  agentStream: Stream
}

/**
 * Create a pair of connected ACP streams for in-process communication.
 * Uses TransformStream pairs to create bidirectional channels
 * that work in any JS environment (browser, Node, Web Worker).
 */
export const createInProcessStreams = (): StreamPair => {
  // Client writes → Agent reads
  const clientToAgent = new TransformStream<Uint8Array>()
  // Agent writes → Client reads
  const agentToClient = new TransformStream<Uint8Array>()

  const clientStream = ndJsonStream(clientToAgent.writable, agentToClient.readable)
  const agentStream = ndJsonStream(agentToClient.writable, clientToAgent.readable)

  return { clientStream, agentStream }
}
