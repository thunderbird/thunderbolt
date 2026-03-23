import { AgentSideConnection, ndJsonStream } from '@agentclientprotocol/sdk'
import type { HaystackClient } from './client'
import type { HaystackPipelineConfig } from './types'
import { createHaystackAcpAgent } from './acp-agent'

type ConnectionState = {
  writer: WritableStreamDefaultWriter<Uint8Array>
  cleanup: () => void
}

// Per-connection state keyed by Elysia's ws.id
const connections = new Map<string, ConnectionState>()

type ElysiaWS = {
  id: string
  send: (data: string | ArrayBuffer) => void
}

/**
 * Creates Elysia WebSocket handlers that bridge to ACP ndJSON streams.
 * Each WebSocket connection creates a fresh ACP AgentSideConnection.
 */
export const createHaystackWebSocketHandler = (pipelineConfig: HaystackPipelineConfig, client: HaystackClient) => ({
  open(ws: ElysiaWS) {
    const clientToAgent = new TransformStream<Uint8Array>()
    const agentToClient = new TransformStream<Uint8Array>()

    const agentStream = ndJsonStream(agentToClient.writable, clientToAgent.readable)

    const agentHandler = createHaystackAcpAgent({ client, pipelineConfig })
    new AgentSideConnection(agentHandler, agentStream)

    // Pipe outgoing ACP messages back to WebSocket
    const reader = agentToClient.readable.getReader()
    const decoder = new TextDecoder()
    let closed = false

    const pipeLoop = async () => {
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done || closed) {
            break
          }
          ws.send(decoder.decode(value))
        }
      } catch {
        // Connection closed
      }
    }
    pipeLoop()

    const writer = clientToAgent.writable.getWriter()

    connections.set(ws.id, {
      writer,
      cleanup: () => {
        closed = true
        writer.close().catch(() => {})
        reader.cancel().catch(() => {})
      },
    })
  },

  message(ws: ElysiaWS, message: unknown) {
    const state = connections.get(ws.id)
    if (!state) {
      return
    }

    const encoder = new TextEncoder()
    // Elysia auto-parses JSON messages into objects — re-serialize for ndJSON stream
    const data = typeof message === 'string' ? message : JSON.stringify(message)
    state.writer.write(encoder.encode(data + '\n')).catch(() => {})
  },

  close(ws: ElysiaWS) {
    const state = connections.get(ws.id)
    state?.cleanup()
    connections.delete(ws.id)
  },
})
