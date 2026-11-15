/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { expect, test } from 'bun:test'
import Anthropic from '@anthropic-ai/sdk'
import { z } from 'zod'
import { createFakeProvider, fakeProviderReply } from './fake-provider'
import { miniAppToolsetName, miniAppTransferPrompt, protectedEmailBody, protectedEmailId } from './mini-app-fixture'
import {
  officeDeckEditFilename,
  officeDeckEditPrompt,
  officeDeckEditScript,
  officeEditFilename,
  officeEditPrompt,
  officeEditScript,
  officeScript,
  officeScriptPrompt,
  officeWorkbookPrompt,
  officeWorkbookScript,
} from './office-script-fixture'
import { performanceStreamPrompt, performanceStreamReply } from './streaming-fixture'

test('streams a complete reply over IPv4 loopback', async () => {
  const server = await createFakeProvider(0)
  try {
    const address = z.object({ port: z.number() }).parse(server.address())
    const client = new Anthropic({ apiKey: 'test-key', baseURL: `http://127.0.0.1:${address.port}`, maxRetries: 0 })
    const message = await client.messages
      .stream(
        {
          model: 'test-model',
          max_tokens: 100,
          messages: [{ role: 'user', content: 'Hello' }],
        },
        { timeout: 3000 },
      )
      .finalMessage()
    expect(message.content).toMatchObject([{ type: 'text', text: fakeProviderReply, citations: [] }])
    expect(message.stop_reason).toBe('end_turn')
  } finally {
    server.close()
    server.closeAllConnections()
  }
})

test('the named long markdown fixture preserves every character across fixed-size deltas', async () => {
  const server = await createFakeProvider(0, { delayMs: 0 })
  try {
    const address = z.object({ port: z.number() }).parse(server.address())
    const client = new Anthropic({ apiKey: 'test-key', baseURL: `http://127.0.0.1:${address.port}`, maxRetries: 0 })
    const deltas: string[] = []
    const stream = client.messages.stream({
      model: 'test-model',
      max_tokens: 10_000,
      messages: [{ role: 'user', content: [{ type: 'text', text: performanceStreamPrompt }] }],
    })
    stream.on('text', (text) => deltas.push(text))
    const message = await stream.finalMessage()
    expect(deltas.length).toBeGreaterThan(100)
    expect(deltas.every((text) => text.length <= 24)).toBe(true)
    expect(deltas.join('')).toBe(performanceStreamReply)
    expect(message.content).toMatchObject([{ type: 'text', text: performanceStreamReply }])
    expect(message.stop_reason).toBe('end_turn')

    const normal = await client.messages
      .stream({
        model: 'test-model',
        max_tokens: 100,
        messages: [
          { role: 'user', content: performanceStreamPrompt },
          { role: 'assistant', content: 'Done.' },
          { role: 'user', content: 'Hello again.' },
        ],
      })
      .finalMessage()
    expect(normal.content).toMatchObject([{ type: 'text', text: fakeProviderReply }])
  } finally {
    server.close()
    server.closeAllConnections()
  }
})

test('rejects malformed requests without breaking subsequent streams', async () => {
  const server = await createFakeProvider(0, { delayMs: 0 })
  try {
    const { port } = z.object({ port: z.number() }).parse(server.address())
    const baseURL = `http://127.0.0.1:${port}`
    for (const body of ['{', 'null', '{}', '{"messages":{}}', '{"messages":[{"role":"user","content":42}]}']) {
      const response = await fetch(`${baseURL}/v1/messages`, { method: 'POST', body })
      expect(response.status).toBe(400)
      expect(await response.text()).toBe('Invalid Messages request')
    }
    const client = new Anthropic({ apiKey: 'test-key', baseURL, maxRetries: 0 })
    const message = await client.messages
      .stream({ model: 'test-model', max_tokens: 100, messages: [{ role: 'user', content: 'Hello again' }] })
      .finalMessage()
    expect(message.content).toMatchObject([{ type: 'text', text: fakeProviderReply }])
  } finally {
    server.close()
    server.closeAllConnections()
  }
})

test('plays a model that reads an email and passes its body to the open Mini App', async () => {
  const server = await createFakeProvider(0, { delayMs: 0 })
  try {
    const { port } = z.object({ port: z.number() }).parse(server.address())
    const client = new Anthropic({ apiKey: 'test-key', baseURL: `http://127.0.0.1:${port}`, maxRetries: 0 })
    const send = (messages: Anthropic.MessageParam[]) =>
      client.messages.stream({ model: 'test-model', max_tokens: 100, messages }).finalMessage()
    const ask: Anthropic.MessageParam = { role: 'user', content: miniAppTransferPrompt }

    const read = await send([ask])
    expect(read.stop_reason).toBe('tool_use')
    expect(read.content).toMatchObject([
      { type: 'tool_use', name: 'google_get_email', input: { id: protectedEmailId } },
    ])

    const toolResult = (content: string): Anthropic.MessageParam => ({
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'toolu_test', content: [{ type: 'text', text: content }] }],
    })
    const email = JSON.stringify({ id: protectedEmailId, body_text: protectedEmailBody })
    const transfer = await send([ask, { role: 'assistant', content: read.content }, toolResult(email)])
    expect(transfer.content).toMatchObject([
      { type: 'tool_use', name: miniAppToolsetName, input: { note: protectedEmailBody } },
    ])

    const reply = await send([ask, { role: 'assistant', content: transfer.content }, toolResult('Shown.')])
    expect(reply.content).toMatchObject([{ type: 'text', text: fakeProviderReply }])

    // Another tool's JSON result is not an email; it gets the ordinary reply.
    const otherCall: Anthropic.MessageParam = {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'toolu_test', name: 'search', input: {} }],
    }
    const unrelated = await send([ask, otherCall, toolResult('{"count":1}')])
    expect(unrelated.content).toMatchObject([{ type: 'text', text: fakeProviderReply }])
  } finally {
    server.close()
    server.closeAllConnections()
  }
})

test('plays a model that builds a Word document with run_office_script, then replies', async () => {
  const server = await createFakeProvider(0, { delayMs: 0 })
  try {
    const { port } = z.object({ port: z.number() }).parse(server.address())
    const client = new Anthropic({ apiKey: 'test-key', baseURL: `http://127.0.0.1:${port}`, maxRetries: 0 })
    const send = (messages: Anthropic.MessageParam[]) =>
      client.messages.stream({ model: 'test-model', max_tokens: 100, messages }).finalMessage()
    const ask: Anthropic.MessageParam = { role: 'user', content: officeScriptPrompt }

    const call = await send([ask])
    expect(call.content).toMatchObject([
      { type: 'tool_use', name: 'run_office_script', input: { script: officeScript } },
    ])

    const reply = await send([
      ask,
      { role: 'assistant', content: call.content },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_test', content: '{"ok":true}' }] },
    ])
    expect(reply.content).toMatchObject([{ type: 'text', text: fakeProviderReply }])
  } finally {
    server.close()
    server.closeAllConnections()
  }
})

test('plays a model that builds a workbook with run_office_script', async () => {
  const server = await createFakeProvider(0, { delayMs: 0 })
  try {
    const { port } = z.object({ port: z.number() }).parse(server.address())
    const client = new Anthropic({ apiKey: 'test-key', baseURL: `http://127.0.0.1:${port}`, maxRetries: 0 })
    const ask: Anthropic.MessageParam = { role: 'user', content: officeWorkbookPrompt }

    const call = await client.messages.stream({ model: 'test-model', max_tokens: 100, messages: [ask] }).finalMessage()
    expect(call.content).toMatchObject([
      { type: 'tool_use', name: 'run_office_script', input: { script: officeWorkbookScript } },
    ])
  } finally {
    server.close()
    server.closeAllConnections()
  }
})

test('plays a model that edits the attached document with run_office_script', async () => {
  const server = await createFakeProvider(0, { delayMs: 0 })
  try {
    const { port } = z.object({ port: z.number() }).parse(server.address())
    const client = new Anthropic({ apiKey: 'test-key', baseURL: `http://127.0.0.1:${port}`, maxRetries: 0 })
    const ask: Anthropic.MessageParam = {
      role: 'user',
      content: [
        { type: 'text', text: `${officeEditPrompt}\n\n[Attached: ${officeEditFilename}]` },
        { type: 'text', text: 'Status: {{status}}' },
      ],
    }

    const call = await client.messages.stream({ model: 'test-model', max_tokens: 100, messages: [ask] }).finalMessage()
    expect(call.content).toMatchObject([
      {
        type: 'tool_use',
        name: 'run_office_script',
        input: { script: officeEditScript, inputs: [officeEditFilename] },
      },
    ])
  } finally {
    server.close()
    server.closeAllConnections()
  }
})

test('plays a model that edits the attached deck with run_office_script', async () => {
  const server = await createFakeProvider(0, { delayMs: 0 })
  try {
    const { port } = z.object({ port: z.number() }).parse(server.address())
    const client = new Anthropic({ apiKey: 'test-key', baseURL: `http://127.0.0.1:${port}`, maxRetries: 0 })
    const ask: Anthropic.MessageParam = {
      role: 'user',
      content: [
        {
          type: 'text',
          text: `[Attachment: ${officeDeckEditFilename}]\n\n## Slide 1\nStatus: {{status}}\n${officeDeckEditPrompt}`,
        },
      ],
    }

    const call = await client.messages.stream({ model: 'test-model', max_tokens: 100, messages: [ask] }).finalMessage()
    expect(call.content).toMatchObject([
      {
        type: 'tool_use',
        name: 'run_office_script',
        input: { script: officeDeckEditScript, inputs: [officeDeckEditFilename] },
      },
    ])
  } finally {
    server.close()
    server.closeAllConnections()
  }
})
