/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { createServer, type Server } from 'node:http'
import { json } from 'node:stream/consumers'
import { setTimeout } from 'node:timers/promises'
import type { RawMessageStreamEvent } from '@anthropic-ai/sdk/resources/messages'
import { z } from 'zod'
import { performanceStreamOptions, performanceStreamPrompt } from './streaming-fixture'

export const fakeProviderReply = 'Hello from the fake provider, one word at a time.'
export const browserBannerPrompt = 'Exercise the native browser banner at '
export const browserBannerThinking = 'Browser tools finished; checking the page.'
export const browserBannerReply = `${browserBannerThinking} Browser banner test complete.`

type FakeProviderOptions = { delayMs?: number }

const requestSchema = z.object({
  messages: z.array(
    z.object({
      role: z.string(),
      content: z.union([
        z.string(),
        z.array(
          z.object({
            type: z.string(),
            text: z.string().optional(),
            tool_use_id: z.string().optional(),
            content: z.unknown().optional(),
          }),
        ),
      ]),
    }),
  ),
})

/** Decode text without mistaking a tool result for a new user prompt. */
const messageText = (content: z.infer<typeof requestSchema>['messages'][number]['content']) =>
  typeof content === 'string'
    ? content
    : content
        .filter((part) => part.type === 'text')
        .map((part) => part.text ?? '')
        .join('\n')

/** Opt in only the latest human prompt and only allow local fixture URLs. */
const browserBannerStep = (request: z.infer<typeof requestSchema>) => {
  const promptIndex = request.messages.findLastIndex(
    (message) => message.role === 'user' && messageText(message.content),
  )
  const prompt = request.messages[promptIndex]
  const text = prompt ? messageText(prompt.content) : ''
  if (!text.startsWith(browserBannerPrompt)) {
    return null
  }
  const url = URL.parse(text.slice(browserBannerPrompt.length).trim())
  if (!url || url.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(url.hostname)) {
    return null
  }
  const results = request.messages
    .slice(promptIndex + 1)
    .flatMap((message) =>
      Array.isArray(message.content) ? message.content.filter((part) => part.type === 'tool_result') : [],
    )
  const opened = results.find((part) => part.tool_use_id === 'browser-banner-open')
  if (!opened) {
    return { id: 'browser-banner-open', name: 'browser_tabs', input: { action: 'open', url: url.href } }
  }
  if (results.some((part) => part.tool_use_id === 'browser-banner-snapshot')) {
    return { done: true } as const
  }
  const content = z
    .union([z.string(), z.array(z.object({ type: z.string(), text: z.string().optional() }))])
    .parse(opened.content)
  const { tab } = z.object({ tab: z.object({ id: z.string() }) }).parse(JSON.parse(messageText(content)))
  return { id: 'browser-banner-snapshot', name: 'browser_snapshot', input: { tabId: tab.id } }
}

/** Only the last user turn can opt into the expensive fixture; ordinary replies retain their original timing. */
const requestsPerformanceStream = (request: z.infer<typeof requestSchema>) => {
  const content = request.messages.findLast((message) => message.role === 'user')?.content
  const text =
    typeof content === 'string'
      ? content
      : content
          ?.filter((part) => part.type === 'text')
          .map((part) => part.text ?? '')
          .join('\n')
  return text === performanceStreamPrompt
}

/** Start a local Anthropic Messages provider with a deterministic streamed reply. */
export const createFakeProvider = async (port: number, options: FakeProviderOptions = {}): Promise<Server> => {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, `http://localhost:${port}`)
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
    const banner = browserBannerStep(request)
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
    if (banner && !('done' in banner)) {
      writeEvent({
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: banner.id, name: banner.name, input: {}, caller: { type: 'direct' } },
      })
      writeEvent({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: JSON.stringify(banner.input) },
      })
      writeEvent({ type: 'content_block_stop', index: 0 })
      writeEvent({
        type: 'message_delta',
        delta: { stop_reason: 'tool_use', stop_sequence: null, stop_details: null, container: null },
        usage: { ...usage, output_tokens: 20 },
      })
      writeEvent({ type: 'message_stop' })
      res.end()
      return
    }
    writeEvent({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '', citations: [] } })
    if (banner) {
      writeEvent({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: browserBannerThinking } })
      // This gap is deliberately after both native tools return, when a per-call banner disappears.
      await setTimeout(options.delayMs ?? 3000)
    }
    for (const text of banner ? [' Browser banner test complete.'] : chunks) {
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
