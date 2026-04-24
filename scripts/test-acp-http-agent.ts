/**
 * Minimal ACP Streamable HTTP test agent.
 * Run: bun scripts/test-acp-http-agent.ts
 * Add in Thunderbolt dialog: http://localhost:9999/acp
 */

let connectionCounter = 0
let sessionCounter = 0

const handleJsonRpc = (msg: { id?: number; method?: string; params?: Record<string, unknown> }, connectionId: string) => {
  switch (msg.method) {
    case 'initialize':
      return {
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          protocolVersion: 1,
          agentInfo: { name: 'Test ACP HTTP Agent', version: '1.0.0' },
          agentCapabilities: {
            loadSession: false,
            promptCapabilities: { image: false, audio: false, embeddedContext: false },
          },
        },
      }

    case 'session/new': {
      const sessionId = `sess_${++sessionCounter}`
      return {
        jsonrpc: '2.0',
        id: msg.id,
        result: { sessionId },
        _sessionId: sessionId,
      }
    }

    case 'session/prompt':
      return { type: 'streaming', id: msg.id, params: msg.params }

    default:
      return { jsonrpc: '2.0', id: msg.id, result: {} }
  }
}

const sseEvent = (data: unknown) => `data: ${JSON.stringify(data)}\n\n`

const streamPromptResponse = (id: number, sessionId: string) => {
  const chunks = [
    'Hello from the **ACP HTTP test agent**! ',
    'This response is streamed via SSE. ',
    'If you can read this, the HTTP relay proxy is working correctly.',
  ]

  const encoder = new TextEncoder()
  return new ReadableStream({
    async start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(
          encoder.encode(
            sseEvent({
              jsonrpc: '2.0',
              method: 'session/update',
              params: {
                sessionId,
                update: {
                  sessionUpdate: 'agent_message_chunk',
                  content: { type: 'text', text: chunk },
                },
              },
            }),
          ),
        )
        await new Promise((r) => setTimeout(r, 200))
      }

      controller.enqueue(
        encoder.encode(
          sseEvent({ jsonrpc: '2.0', id, result: { stopReason: 'end_turn' } }),
        ),
      )
      controller.close()
    },
  })
}

Bun.serve({
  port: 9999,
  fetch(req) {
    const url = new URL(req.url)
    if (url.pathname !== '/acp') {
      return new Response('Not found', { status: 404 })
    }

    if (req.method === 'POST') {
      return (async () => {
        const msg = await req.json()
        const connectionId = req.headers.get('Acp-Connection-Id') ?? `conn_${++connectionCounter}`
        const sessionId = req.headers.get('Acp-Session-Id') ?? undefined

        console.log(`← ${msg.method ?? 'response'} (conn=${connectionId}, sess=${sessionId ?? 'none'})`)

        const result = handleJsonRpc(msg, connectionId)

        // Streaming prompt response
        if (result && 'type' in result && result.type === 'streaming') {
          const promptSessionId = (result.params?.sessionId as string) ?? sessionId ?? 'unknown'
          console.log(`  → streaming SSE response for prompt (session=${promptSessionId})`)
          return new Response(streamPromptResponse(result.id, promptSessionId), {
            headers: {
              'Content-Type': 'text/event-stream',
              'Cache-Control': 'no-cache',
              'Acp-Connection-Id': connectionId,
              ...(sessionId ? { 'Acp-Session-Id': sessionId } : {}),
            },
          })
        }

        // Extract session ID if this was a session/new response
        const newSessionId = result && '_sessionId' in result ? (result._sessionId as string) : undefined
        const cleanResult = { ...result }
        if ('_sessionId' in cleanResult) delete cleanResult._sessionId

        const headers: Record<string, string> = {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Acp-Connection-Id': connectionId,
        }
        if (newSessionId) headers['Acp-Session-Id'] = newSessionId
        else if (sessionId) headers['Acp-Session-Id'] = sessionId

        // Single response wrapped as SSE event
        const body = sseEvent(cleanResult)
        return new Response(body, { headers })
      })()
    }

    return new Response('Method not allowed', { status: 405 })
  },
})

console.log('🧪 Test ACP HTTP agent running at http://localhost:9999/acp')
console.log('   Add this URL in the Thunderbolt "Add Custom Agent" dialog')
