import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import type { LanguageModelV2StreamPart } from '@ai-sdk/provider'
import { extractReasoningMiddleware, simulateReadableStream, streamText, wrapLanguageModel } from 'ai'
import { MockLanguageModelV2 } from 'ai/test'
import { describe, expect, it } from 'bun:test'
import fs from 'fs'
import { join } from 'path'
import { createSimulatedFetch, createUIMessageTransform, parseSseLog, streamTextToUIMessage } from './util'

describe.skip('sse', async () => {
  it('should return a readable stream', async () => {
    const result = streamText({
      model: new MockLanguageModelV2({
        doStream: async () => ({
          stream: simulateReadableStream<LanguageModelV2StreamPart>({
            initialDelayInMs: 1000, // Delay before the first chunk
            chunkDelayInMs: 300, // Delay between chunks
            chunks: [
              {
                type: 'reasoning',
                text: "\nOkay, the user said \"hi\". I need to respond appropriately. Since they didn't ask a question or request anything specific, I should greet them back and offer assistance. Let me check if there's any tool I need to use here. They didn't mention anything that requires a tool, so a simple response should suffice. I'll make sure to keep it friendly and open-ended.\n\nMaybe add an emoji to keep it approachable. Let me structure it with a subheader and some bullet points for clarity. Wait, the user might be looking for help with something, so I should prompt them to ask questions. Also, remember to ask for their location if they need location-based help. But since they haven't asked for anything like that yet, maybe just a general offer to assist. Alright, let's put it all together.\n",
              },
              {
                type: 'text',
                text: "Hello! 👋 How can I assist you today? Whether you have questions, need help with planning, or just want to chat, I'm here for you! Let me know how I can be helpful. 🌟  \n\n**Need help with:**  \n- Finding information?  \n- Scheduling or reminders?  \n- General advice or ideas?  \n\nJust ask! 😊",
              },
              {
                type: 'finish',
                finishReason: 'stop',
                usage: {
                  inputTokens: 10,
                  outputTokens: 10,
                  totalTokens: 20,
                },
              },
            ],
          }),
        }),
      }),
      prompt: 'Hello, test!',
    })

    for await (const chunk of result.fullStream) {
      console.log('chunk', chunk)
    }

    // await result.consumeStream()
    // console.log('result.content', await result.steps)
  })
})

const chunks = parseSseLog(fs.readFileSync(join(__dirname, 'tests/banana/stream.sse'), 'utf8'))

const simulatedFetch = createSimulatedFetch(chunks, {
  initialDelayInMs: 0,
  chunkDelayInMs: 0,
})

const provider = createOpenAICompatible({
  name: 'local-test',
  baseURL: 'http://localhost:3000',
  fetch: simulatedFetch,
})

const model = provider('test-model')

const wrappedModel = wrapLanguageModel({
  model,
  middleware: [extractReasoningMiddleware({ tagName: 'think' })],
})

describe.skip('sse', async () => {
  it('should return a readable stream', async () => {
    const result = streamText({
      model: wrappedModel,
      prompt: 'Hello, test!',
    })

    // Transform the raw chunk stream into UIMessage snapshots
    const messageStream = result.fullStream.pipeThrough(createUIMessageTransform())
    const reader = messageStream.getReader()

    let finalMessage
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        finalMessage = value
        console.log('UIMessage Streaming Snapshot:', JSON.stringify(value, null, 2))
      }
    } finally {
      reader.releaseLock()
    }
  })
})

describe('sse', async () => {
  it('should return a readable stream', async () => {
    const result = streamText({
      model: wrappedModel,
      prompt: '<test>',
    })

    const message = await streamTextToUIMessage(result)

    // Load expected message from JSON file for deep comparison
    const expectedMessage = JSON.parse(fs.readFileSync(join(__dirname, 'tests/banana/message.json'), 'utf8'))

    // console.log('message', message)

    expect(message).toEqual(expectedMessage)
  })
})
