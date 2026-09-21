/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { createServer, type Server } from 'node:http'
import { setTimeout } from 'node:timers/promises'
import type { ChatCompletionChunk } from 'openai/resources/chat/completions'

export const fakeProviderReply = 'Hello from the fake provider, one word at a time.'

/** Start a local OpenAI-compatible provider with a deterministic streamed reply. */
export const createFakeProvider = async (port: number): Promise<Server> => {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, `http://localhost:${port}`)
    if (req.method !== 'POST' || !url.pathname.endsWith('/chat/completions')) {
      res.writeHead(404)
      res.end('Not found')
      return
    }

    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
    const base = {
      id: `chatcmpl-${crypto.randomUUID()}`,
      object: 'chat.completion.chunk' as const,
      created: Math.floor(Date.now() / 1000),
      model: 'e2e-model',
    }
    /** Write one event using the same completion identity throughout the stream. */
    const writeChunk = (delta: ChatCompletionChunk.Choice.Delta, finishReason: 'stop' | null = null) => {
      res.write(
        `data: ${JSON.stringify({
          ...base,
          choices: [{ index: 0, delta, finish_reason: finishReason }],
          usage: finishReason ? { prompt_tokens: 10, completion_tokens: 8, total_tokens: 18 } : undefined,
        })}\n\n`,
      )
    }
    writeChunk({ role: 'assistant', content: '' })
    for (const content of fakeProviderReply.match(/\S+\s*/g)!) {
      await setTimeout(150)
      if (res.destroyed) return
      writeChunk({ content })
    }
    writeChunk({}, 'stop')
    res.end('data: [DONE]\n\n')
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, 'localhost', resolve)
  })
  console.log(`Fake provider started on port ${port}`)
  return server
}
