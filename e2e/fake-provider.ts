/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { createServer, type Server } from 'node:http'
import { setTimeout } from 'node:timers/promises'
import type { RawMessageStreamEvent } from '@anthropic-ai/sdk/resources/messages'

export const fakeProviderReply = 'Hello from the fake provider, one word at a time.'
export const fakeArtifactPrompt = 'Create the deterministic artifact integration fixture.'
export const fakeArtifactTitle = 'Artifact integration fixture'
const fakeArtifactToolId = 'toolu_e2e_artifact'
const fakeArtifactHtml = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Artifact integration fixture</title>
<style>body { font-family: sans-serif; padding: 24px; } button { padding: 8px; } output { margin-left: 12px; }</style>
</head><body><h1>Interactive artifact</h1><button id="increment">Increment</button><output id="counter" aria-label="Counter">0</output>
<script>document.getElementById('increment').addEventListener('click', () => {
const counter = document.getElementById('counter'); counter.textContent = String(Number(counter.textContent) + 1);
});</script></body></html>`

/** Start a local Anthropic Messages provider with a deterministic streamed reply. */
export const createFakeProvider = async (port: number): Promise<Server> => {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, `http://localhost:${port}`)
    if (req.method !== 'POST' || !url.pathname.endsWith('/v1/messages')) {
      res.writeHead(404)
      res.end('Not found')
      return
    }

    // The marker is unique to this fixture. Its completed tool call appears in the
    // next request's history, so that request receives the ordinary final reply.
    const chunks: string[] = []
    for await (const chunk of req) {
      chunks.push(String(chunk))
    }
    const requestBody = chunks.join('')
    const renderArtifact = requestBody.includes(fakeArtifactPrompt) && !requestBody.includes(fakeArtifactToolId)

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
    if (renderArtifact) {
      writeEvent({
        type: 'content_block_start',
        index: 0,
        content_block: {
          type: 'tool_use',
          id: fakeArtifactToolId,
          name: 'render_html',
          input: {},
          caller: { type: 'direct' },
        },
      })
      const input = JSON.stringify({ html: fakeArtifactHtml, title: fakeArtifactTitle })
      for (const partialJson of input.match(/.{1,80}/gs) ?? []) {
        await setTimeout(15)
        if (res.destroyed) {
          return
        }
        writeEvent({
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'input_json_delta', partial_json: partialJson },
        })
      }
    } else {
      writeEvent({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '', citations: [] } })
      for (const text of fakeProviderReply.match(/\S+\s*/g)!) {
        await setTimeout(150)
        if (res.destroyed) {
          return
        }
        writeEvent({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } })
      }
    }
    writeEvent({ type: 'content_block_stop', index: 0 })
    writeEvent({
      type: 'message_delta',
      delta: {
        stop_reason: renderArtifact ? 'tool_use' : 'end_turn',
        stop_sequence: null,
        stop_details: null,
        container: null,
      },
      usage: { ...usage, output_tokens: 8 },
    })
    writeEvent({ type: 'message_stop' })
    res.end()
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, 'localhost', resolve)
  })
  console.log(`Fake provider started on port ${port}`)
  return server
}
