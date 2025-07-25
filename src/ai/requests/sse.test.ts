import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import type { LanguageModelV2StreamPart } from '@ai-sdk/provider'
import { extractReasoningMiddleware, simulateReadableStream, streamText, wrapLanguageModel } from 'ai'
import { MockLanguageModelV2 } from 'ai/test'
import { describe, it } from 'bun:test'
import fs from 'fs'
import { join } from 'path'

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
          }), // .pipeThrough(new TextEncoderStream()),
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

// Read the recorded SSE stream and ensure that every chunk ends with a double newline
// The OpenAI-compatible SSE parser expects each event to be terminated by an empty line
// ("\n\n").  When we simply `split` on every single newline the delimiters are lost, which
// means the consumer no longer recognises the event boundaries and eventually fails with
// `finishReason: "error"`.  Keeping the delimiter fixes the issue.
const chunks = fs
  .readFileSync(join(__dirname, 'tests/apple/stream.sse'), 'utf8')
  .trim() // get rid of leading/trailing whitespace so we don't generate an empty chunk
  .split(/\n\n+/) // split **only** on the blank line that separates SSE events
  .filter(Boolean) // defensive: remove potential empty strings
  .map((chunk) => `${chunk}\n\n`) // re-append the delimiter for each chunk

console.log('chunks', chunks[0])

const provider = createOpenAICompatible({
  baseURL: 'http://localhost:3000',
  fetch: async () => {
    return new Response(
      simulateReadableStream({
        // initialDelayInMs: 1000, // Delay before the first chunk
        // chunkDelayInMs: 300, // Delay between chunks
        chunks,
      }).pipeThrough(new TextEncoderStream()),
      {
        status: 200,
        headers: {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache',
        },
      },
    )
  },
})

const model = provider('test-model')

const wrappedModel = wrapLanguageModel({
  model,
  middleware: [extractReasoningMiddleware({ tagName: 'think' })],
})

describe('sse', async () => {
  it('should return a readable stream', async () => {
    const result = streamText({
      model: wrappedModel,
      prompt: 'Hello, test!',
    })

    for await (const chunk of result.fullStream) {
      // console.log('chunk2', chunk)
    }

    for await (const step of await result.steps) {
      console.log('step', step)
    }
  })
})
