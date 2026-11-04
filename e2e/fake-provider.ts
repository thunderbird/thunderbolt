/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { setTimeout } from 'node:timers/promises'
import type { RawMessageStreamEvent } from '@anthropic-ai/sdk/resources/messages'
import { z } from 'zod'

export const fakeProviderReply = 'Hello from the fake provider, one word at a time.'

/**
 * Starts the line the fake logs, followed by an ISO time, for a request it does not implement. The QA replay reads it
 * from the stack log and shows it to the judge, so a failure the fake causes is not filed as an app bug.
 */
export const unsupportedRequestMarker = '[fake-provider] unsupported'

const replyWords = fakeProviderReply.match(/\S+\s*/g)!

/** Writes each word of the reply after a pause; stops early once the client has gone (a stopped reply). */
const streamWords = async (res: ServerResponse, write: (text: string) => void) => {
  for (const text of replyWords) {
    await setTimeout(150)
    if (res.destroyed) {
      return false
    }
    write(text)
  }
  return true
}

/** The native Anthropic Messages stream, which the backend's `/chat/v1/messages` route relays. */
const streamMessages = async (res: ServerResponse) => {
  /** Write a native Messages event with its SSE event name. */
  const writeEvent = (event: RawMessageStreamEvent) => {
    res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
  }
  const usage = {
    input_tokens: 10,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation: null,
    inference_geo: null,
    server_tool_use: null,
    service_tier: null,
  }
  writeEvent({
    type: 'message_start',
    message: {
      id: `msg_${crypto.randomUUID()}`,
      type: 'message',
      role: 'assistant',
      model: 'claude-opus-5-5',
      content: [],
      container: null,
      stop_details: null,
      stop_reason: null,
      stop_sequence: null,
      usage,
    },
  })
  writeEvent({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '', citations: [] } })
  const finished = await streamWords(res, (text) =>
    writeEvent({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }),
  )
  if (!finished) {
    return
  }
  writeEvent({ type: 'content_block_stop', index: 0 })
  writeEvent({
    type: 'message_delta',
    delta: { stop_reason: 'end_turn', stop_sequence: null, stop_details: null, container: null },
    usage: { ...usage, output_tokens: 8 },
  })
  writeEvent({ type: 'message_stop' })
}

type ChunkChoice = { index: 0; delta: { role?: 'assistant'; content?: string }; finish_reason: 'stop' | null }
type ChunkUsage = { prompt_tokens: number; completion_tokens: number; total_tokens: number }

/**
 * The OpenAI-compatible chat completions stream, which the backend's `/chat/completions` route relays for a managed
 * model without the Anthropic vendor. It ends with the usage chunk the backend's ledger reads.
 */
const streamChatCompletion = async (res: ServerResponse, model: string) => {
  const id = `chatcmpl-${crypto.randomUUID()}`
  const created = Math.floor(Date.now() / 1000)
  const writeChunk = (choices: ChunkChoice[], usage: ChunkUsage | null = null) => {
    res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model, choices, usage })}\n\n`)
  }
  writeChunk([{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }])
  const finished = await streamWords(res, (content) =>
    writeChunk([{ index: 0, delta: { content }, finish_reason: null }]),
  )
  if (!finished) {
    return
  }
  writeChunk([{ index: 0, delta: {}, finish_reason: 'stop' }])
  writeChunk([], { prompt_tokens: 10, completion_tokens: 8, total_tokens: 18 })
  res.write('data: [DONE]\n\n')
}

const requestSchema = z.object({ stream: z.boolean().optional(), model: z.string().default('fake-model') })

/** The fields the fake reads from a JSON request body, or undefined when it is not JSON or has another shape. */
const readRequest = async (req: IncomingMessage) => {
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    chunks.push(chunk)
  }
  try {
    return requestSchema.safeParse(JSON.parse(Buffer.concat(chunks).toString())).data
  } catch {
    return undefined
  }
}

/** What the logged request line adds after its method and path: why a POST body was not one the fake answers. */
const requestProblem = (method: string | undefined, body: z.infer<typeof requestSchema> | undefined) => {
  if (method !== 'POST') {
    return ''
  }
  if (!body) {
    return ' with a body that is not a JSON request'
  }
  return body.stream === true ? '' : ' without "stream": true'
}

/**
 * Start a local LLM provider with a deterministic streamed reply. It answers what the backend sends it: streamed
 * Anthropic Messages (`/v1/messages`) and streamed OpenAI-compatible chat completions (`/v1/chat/completions`).
 * Anything else gets a 404 and an `unsupportedRequestMarker` line on stderr.
 */
export const createFakeProvider = async (port: number): Promise<Server> => {
  const server = createServer(async (req, res) => {
    const { pathname } = new URL(req.url!, `http://localhost:${port}`)
    const body = req.method === 'POST' ? await readRequest(req) : undefined
    const stream = body?.stream === true
    if (stream && pathname === '/v1/messages') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
      await streamMessages(res)
      res.end()
      return
    }
    if (stream && pathname === '/v1/chat/completions') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
      await streamChatCompletion(res, body.model)
      res.end()
      return
    }
    const request = `${req.method} ${pathname}${requestProblem(req.method, body)}`
    console.warn(`${unsupportedRequestMarker} ${new Date().toISOString()} ${request}`)
    res.writeHead(404, { 'Content-Type': 'text/plain' })
    res.end(`The fake provider does not implement ${request}`)
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    // Bun's backend fetch uses IPv4 even when localhost resolves to ::1 first.
    server.listen(port, '127.0.0.1', resolve)
  })
  console.log(`Fake provider started on port ${port}`)
  return server
}
