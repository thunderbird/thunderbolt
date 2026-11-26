/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Harness-seam regression tests for a reply cut off by the output limit while the
 * model was still reasoning (`finish_reason: "length"`, reasoning only). Each
 * test drives a real app harness over a fake provider fetch and reads the AI SDK
 * stream the chat UI consumes.
 */

import { describe, expect, it } from 'bun:test'
import { z } from 'zod'
import { buildAppHarness, type PiModelDescriptor } from './build-app-harness.ts'
import { outputLimitNudge } from './output-limit.ts'
import { piHarnessToUiMessageStream, type AiSdkChunk } from './pi-to-aisdk-stream.ts'

/** The slice of an OpenAI chat-completion chunk delta these tests stream. */
type Delta = {
  role?: 'assistant'
  content?: string
  reasoning_content?: string
  tool_calls?: { index: number; id: string; type: 'function'; function: { name: string; arguments: string } }[]
}

const chunk = (delta: Delta, finishReason: 'stop' | 'length' | 'network_error' | null) =>
  `data: ${JSON.stringify({
    id: 'c',
    object: 'chat.completion.chunk',
    created: 1,
    model: 'deepseek-v4-1-flash',
    choices: [{ index: 0, delta, finish_reason: finishReason }],
    usage: { prompt_tokens: 12_000, completion_tokens: 100, total_tokens: 12_100 },
  })}`

/** A provider stream carrying one delta, then the finish reason. */
const sse = (delta: Delta, finishReason: 'stop' | 'length'): Response =>
  new Response([chunk(delta, null), chunk({}, finishReason), 'data: [DONE]', ''].join('\n\n'), {
    headers: { 'content-type': 'text/event-stream' },
  })

const thinkingOnlyLength = (): Response =>
  sse({ role: 'assistant', reasoning_content: 'Planning the three slides... ' }, 'length')

const answer = (): Response => sse({ role: 'assistant', content: 'Done.' }, 'stop')

const truncatedToolCall = (): Response =>
  sse(
    {
      role: 'assistant',
      tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'read', arguments: '{"path":' } }],
    },
    'length',
  )

const wireBodySchema = z.object({
  max_completion_tokens: z.number().optional(),
  messages: z.array(z.object({ role: z.string(), content: z.unknown() })),
})
type WireBody = z.infer<typeof wireBodySchema>

/** The confidential DeepSeek model the bug was diagnosed on. */
const confidentialModel = (fetch: PiModelDescriptor['fetch']): PiModelDescriptor => ({
  kind: 'confidential',
  providerId: 'tinfoil',
  modelId: 'deepseek-v4-1-flash',
  vendor: 'deepseek',
  baseURL: 'https://enclave.example/v1',
  apiKey: 'placeholder',
  reasoning: true,
  contextWindow: 1_048_576,
  supportsImages: false,
  fetch,
})

/** Builds a harness whose provider answers with `replies` in order and fails any extra call. */
const buildHarness = async (
  replies: (() => Response)[],
  model: (fetch: PiModelDescriptor['fetch']) => PiModelDescriptor = confidentialModel,
) => {
  const bodies: WireBody[] = []
  const fetch = async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    bodies.push(wireBodySchema.parse(JSON.parse(String(init?.body))))
    const reply = replies[bodies.length - 1]
    if (!reply) {
      throw new Error(`unexpected provider call ${bodies.length}`)
    }
    return reply()
  }
  const harness = await buildAppHarness({
    model: model(fetch),
    systemPrompt: 'Answer briefly.',
    thinkingLevel: 'low',
    threadId: crypto.randomUUID(),
  })
  return { harness, bodies }
}

/** Runs one user turn through the UI stream and returns the provider bodies and the chunks. */
const runTurn = async (replies: (() => Response)[]) => {
  const { harness, bodies } = await buildHarness(replies)
  const stream = piHarnessToUiMessageStream(harness, async () => {
    await harness.prompt('Make me a three-slide deck.')
    await harness.waitForIdle()
  })
  const chunks = (await new Response(stream).text())
    .split('\n\n')
    .filter((line) => line.startsWith('data: {'))
    .map((line) => JSON.parse(line.slice('data: '.length)) as AiSdkChunk)
  return { bodies, chunks }
}

const textOf = (chunks: AiSdkChunk[]): string =>
  chunks.flatMap((chunk) => (chunk.type === 'text-delta' ? [chunk.delta] : [])).join('')

const errorsOf = (chunks: AiSdkChunk[]): string[] =>
  chunks.flatMap((chunk) => (chunk.type === 'error' ? [chunk.errorText] : []))

/** The serialized content of the last user message the provider received. */
const lastUserContent = (body: WireBody): string =>
  JSON.stringify(body.messages.findLast((message) => message.role === 'user')?.content)

describe('output limit hit while reasoning', () => {
  it('continues once with a nudge the user never sees, then shows the normal reply', async () => {
    const { bodies, chunks } = await runTurn([thinkingOnlyLength, answer])

    expect(bodies).toHaveLength(2)
    expect(lastUserContent(bodies[0]!)).toContain('Make me a three-slide deck.')
    expect(lastUserContent(bodies[1]!)).toContain(outputLimitNudge)
    expect(textOf(chunks)).toBe('Done.')
    expect(errorsOf(chunks)).toEqual([])
    expect(JSON.stringify(chunks)).not.toContain(outputLimitNudge)
    expect(chunks.at(-1)).toEqual({ type: 'finish' })
  })

  it('ends with a visible, non-retryable error when the second attempt is cut off too', async () => {
    const { bodies, chunks } = await runTurn([thinkingOnlyLength, thinkingOnlyLength])

    expect(bodies).toHaveLength(2)
    expect(textOf(chunks)).toBe('')
    const errors = errorsOf(chunks)
    expect(errors).toHaveLength(1)
    expect(JSON.parse(errors[0]!)).toMatchObject({ kind: 'output-limit', isRetryable: false })
    expect(chunks.at(-1)).toEqual({ type: 'finish' })
  })

  it('recovers again on a later user turn', async () => {
    const { harness, bodies } = await buildHarness([thinkingOnlyLength, answer, thinkingOnlyLength, answer])

    expect((await harness.prompt('first')).stopReason).toBe('stop')
    expect((await harness.prompt('second')).stopReason).toBe('stop')
    expect(bodies).toHaveLength(4)
  })

  it('leaves a normal stop untouched', async () => {
    const { bodies, chunks } = await runTurn([answer])

    expect(bodies).toHaveLength(1)
    expect(textOf(chunks)).toBe('Done.')
    expect(errorsOf(chunks)).toEqual([])
  })

  it("keeps Pi's handling of a tool call cut off by the limit", async () => {
    const { bodies, chunks } = await runTurn([truncatedToolCall, answer])

    expect(bodies).toHaveLength(2)
    expect(chunks.some((chunk) => chunk.type === 'tool-output-error' && chunk.toolCallId === 'call_1')).toBe(true)
    expect(lastUserContent(bodies[1]!)).toContain('Make me a three-slide deck.')
    expect(textOf(chunks)).toBe('Done.')
    expect(errorsOf(chunks)).toEqual([])
  })

  it('asks for a 32k output budget on the wire for a confidential model', async () => {
    const { bodies } = await runTurn([answer])

    expect(bodies[0]).toMatchObject({ max_completion_tokens: 32_768 })
  })

  it('keeps the 8k output budget for a user endpoint', async () => {
    const { harness, bodies } = await buildHarness([answer], (fetch) => ({
      kind: 'openai-compat',
      providerId: 'custom',
      modelId: 'my-model',
      baseURL: 'https://llm.example/v1',
      apiKey: 'placeholder',
      reasoning: false,
      supportsImages: false,
      fetch,
    }))

    await harness.prompt('hi')
    expect(bodies[0]).toMatchObject({ max_completion_tokens: 8_192 })
  })
})

it.each(['length', 'network_error'] as const)(
  'shows the Office call while the provider is paused before its arguments (%s)',
  async (finishReason) => {
    const gate = Promise.withResolvers<void>()
    const headerSeen = Promise.withResolvers<void>()
    const toolDelta = (args: string) =>
      chunk(
        {
          tool_calls: [
            { index: 0, id: 'office-1', type: 'function', function: { name: 'run_office_script', arguments: args } },
          ],
        },
        null,
      )
    const reply = () =>
      new Response(
        new ReadableStream({
          async start(controller) {
            const send = (event: string) => controller.enqueue(new TextEncoder().encode(event + '\n\n'))
            send(toolDelta(''))
            await gate.promise
            send(toolDelta('{"script":"unfinished'))
            send(chunk({}, finishReason))
            send('data: [DONE]')
            controller.close()
          },
        }),
        { headers: { 'content-type': 'text/event-stream' } },
      )
    const { harness } = await buildHarness([reply, answer])
    harness.subscribe((event) => {
      if (event.type === 'message_update' && event.assistantMessageEvent.type === 'toolcall_start') {
        headerSeen.resolve()
      }
    })
    const chunks: AiSdkChunk[] = []
    const drained = piHarnessToUiMessageStream(harness, () => harness.prompt('Create a file.')).pipeTo(
      new WritableStream({
        write(bytes) {
          const line = new TextDecoder().decode(bytes)
          if (line.startsWith('data: {')) {
            chunks.push(JSON.parse(line.slice(6)))
          }
        },
      }),
    )
    try {
      await headerSeen.promise
      // Let the sink drain all chunks produced by the header, with the provider gate still closed.
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
      expect(chunks.filter((event) => 'toolCallId' in event)).toMatchObject([
        { type: 'tool-input-start', toolCallId: 'office-1', toolName: 'run_office_script' },
      ])
    } finally {
      gate.resolve()
      await drained
    }
    const toolEvents = chunks.filter((event) => 'toolCallId' in event).map((event) => event.type)
    if (finishReason === 'network_error') {
      expect(toolEvents).toEqual(['tool-input-start', 'tool-input-error'])
      expect(errorsOf(chunks)).toHaveLength(1)
    } else {
      expect(toolEvents).toEqual(['tool-input-start', 'tool-input-available', 'tool-output-error'])
      expect(textOf(chunks)).toBe('Done.')
    }
  },
)
