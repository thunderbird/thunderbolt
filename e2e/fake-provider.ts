/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { json } from 'node:stream/consumers'
import { setTimeout } from 'node:timers/promises'
import type { RawMessageStreamEvent } from '@anthropic-ai/sdk/resources/messages'
import { z } from 'zod'
import { miniAppToolsetName, miniAppTransferPrompt, protectedEmailId } from './mini-app-fixture'
import { performanceStreamOptions, performanceStreamPrompt } from './streaming-fixture'

export const fakeProviderReply = 'Hello from the fake provider, one word at a time.'

type FakeProviderOptions = { delayMs?: number }

const textPartSchema = z.object({ type: z.string(), text: z.string().optional() })
type TextPart = z.infer<typeof textPartSchema>
const joinText = (parts: TextPart[]) =>
  parts
    .filter((part) => part.type === 'text')
    .map((part) => part.text ?? '')
    .join('\n')
const textSchema = z.union([z.string(), z.array(textPartSchema).transform(joinText)])
// Each message is reduced to its text, the tool it calls, and, for a `tool_result` turn, the result's text.
const contentSchema = z.union([
  z.string().transform((text) => ({ text, toolCall: undefined, toolResult: undefined })),
  z
    .array(textPartSchema.extend({ name: z.string().optional(), content: textSchema.optional() }))
    .transform((parts) => ({
      text: joinText(parts),
      toolCall: parts.find((part) => part.type === 'tool_use')?.name,
      toolResult: parts.find((part) => part.type === 'tool_result')?.content,
    })),
])
const requestSchema = z.object({ messages: z.array(z.object({ role: z.string(), content: contentSchema })) })

type FakeRequest = z.infer<typeof requestSchema>

const lastUserContent = (request: FakeRequest) =>
  request.messages.findLast((message) => message.role === 'user')?.content

/** Only the last user turn can opt into the expensive fixture; ordinary replies retain their original timing. */
const requestsPerformanceStream = (request: FakeRequest) => lastUserContent(request)?.text === performanceStreamPrompt

const emailResultSchema = z.object({ body_text: z.string() })

/** The email body, when the last turn answers the `google_get_email` call this script made. */
const emailBodyFromToolResult = ({ messages }: FakeRequest) => {
  const [call, result] = messages.slice(-2)
  return call?.content.toolCall === 'google_get_email' && result?.content.toolResult !== undefined
    ? emailResultSchema.parse(JSON.parse(result.content.toolResult)).body_text
    : null
}

/**
 * The Mini App transfer script: read the email, then pass its body to the open app's tool, then reply in text. It
 * plays a model that obeys an app's tool description, so the e2e can show what reaches the frame.
 */
const scriptedToolCall = (request: FakeRequest): { name: string; input: Record<string, string> } | null => {
  if (lastUserContent(request)?.text === miniAppTransferPrompt) {
    return { name: 'google_get_email', input: { id: protectedEmailId } }
  }
  const body = emailBodyFromToolResult(request)
  return body === null ? null : { name: miniAppToolsetName, input: { note: body } }
}

/** The model a Local setup finds when it lists this provider's models. */
export const fakeOpenAiModelId = 'fake-model'

// The app's Local mode calls an OpenAI-compatible URL straight from the page, so these routes answer CORS.
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
}
const openAiRequestSchema = z.object({ model: z.string(), stream: z.boolean().optional() })

/**
 * Answer the OpenAI-compatible routes a Local "Other provider" setup uses: the model list, and the reply in one piece
 * or streamed word by word. Returns false for any other route.
 */
const serveOpenAiCompatible = async (
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  delayMs: number,
): Promise<boolean> => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders).end()
    return true
  }
  if (req.method === 'GET' && pathname.endsWith('/v1/models')) {
    res.writeHead(200, { ...corsHeaders, 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ object: 'list', data: [{ id: fakeOpenAiModelId, object: 'model', owned_by: 'e2e' }] }))
    return true
  }
  if (req.method !== 'POST' || !pathname.endsWith('/v1/chat/completions')) {
    return false
  }
  const parsed = openAiRequestSchema.safeParse(await json(req).catch(() => null))
  if (!parsed.success) {
    res.writeHead(400, corsHeaders).end('Invalid chat completions request')
    return true
  }
  const { model, stream } = parsed.data
  const base = { id: `chatcmpl-${crypto.randomUUID()}`, created: Math.floor(Date.now() / 1000), model }
  const usage = { prompt_tokens: 10, completion_tokens: 8, total_tokens: 18 }
  if (!stream) {
    res.writeHead(200, { ...corsHeaders, 'Content-Type': 'application/json' })
    res.end(
      JSON.stringify({
        ...base,
        object: 'chat.completion',
        choices: [{ index: 0, message: { role: 'assistant', content: fakeProviderReply }, finish_reason: 'stop' }],
        usage,
      }),
    )
    return true
  }
  res.writeHead(200, { ...corsHeaders, 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
  const writeChunk = (delta: { role?: 'assistant'; content?: string }, finishReason: 'stop' | null) =>
    res.write(
      `data: ${JSON.stringify({ ...base, object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`,
    )
  writeChunk({ role: 'assistant' }, null)
  for (const content of fakeProviderReply.match(/\S+\s*/g)!) {
    await setTimeout(delayMs)
    if (res.destroyed) {
      return true
    }
    writeChunk({ content }, null)
  }
  writeChunk({}, 'stop')
  res.end('data: [DONE]\n\n')
  return true
}

/**
 * Start a local provider with a deterministic streamed reply: Anthropic Messages for the backend, plus the
 * OpenAI-compatible routes a Local setup connects to directly.
 */
export const createFakeProvider = async (port: number, options: FakeProviderOptions = {}): Promise<Server> => {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, `http://localhost:${port}`)
    if (await serveOpenAiCompatible(req, res, url.pathname, options.delayMs ?? 150)) {
      return
    }
    if (req.method !== 'POST' || !url.pathname.endsWith('/v1/messages')) {
      res.writeHead(404)
      res.end('Not found')
      return
    }

    let request: z.infer<typeof requestSchema>
    try {
      request = requestSchema.parse(await json(req))
    } catch {
      res.writeHead(400)
      res.end('Invalid Messages request')
      return
    }
    const selected = requestsPerformanceStream(request)
      ? performanceStreamOptions
      : { reply: fakeProviderReply, chunkSize: undefined, delayMs: 150 }
    const { reply, chunkSize } = selected
    const chunks = chunkSize
      ? Array.from({ length: Math.ceil(reply.length / chunkSize) }, (_, index) =>
          reply.slice(index * chunkSize, (index + 1) * chunkSize),
        )
      : reply.match(/\S+\s*/g)!

    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
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
    const toolCall = scriptedToolCall(request)
    if (toolCall) {
      writeEvent({
        type: 'content_block_start',
        index: 0,
        content_block: {
          type: 'tool_use',
          id: `toolu_${crypto.randomUUID()}`,
          name: toolCall.name,
          input: {},
          caller: { type: 'direct' },
        },
      })
      writeEvent({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: JSON.stringify(toolCall.input) },
      })
      writeEvent({ type: 'content_block_stop', index: 0 })
      writeEvent({
        type: 'message_delta',
        delta: { stop_reason: 'tool_use', stop_sequence: null, stop_details: null, container: null },
        usage: { ...usage, output_tokens: 8 },
      })
      writeEvent({ type: 'message_stop' })
      res.end()
      return
    }
    writeEvent({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '', citations: [] } })
    for (const text of chunks) {
      await setTimeout(options.delayMs ?? selected.delayMs)
      if (res.destroyed) {
        return
      }
      writeEvent({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } })
    }
    writeEvent({ type: 'content_block_stop', index: 0 })
    writeEvent({
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null, stop_details: null, container: null },
      usage: { ...usage, output_tokens: 8 },
    })
    writeEvent({ type: 'message_stop' })
    res.end()
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    // Bun's backend fetch uses IPv4 even when localhost resolves to ::1 first.
    server.listen(port, '127.0.0.1', resolve)
  })
  // eslint-disable-next-line no-console -- Report the local fixture server's startup in the runner log.
  console.log(`Fake provider started on port ${port}`)
  return server
}
