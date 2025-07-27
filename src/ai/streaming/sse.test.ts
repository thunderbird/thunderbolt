import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import type { LanguageModelV2StreamPart } from '@ai-sdk/provider'
import { simulateReadableStream, streamText, wrapLanguageModel } from 'ai'
import { MockLanguageModelV2 } from 'ai/test'
import { describe, expect, it } from 'bun:test'
import fs from 'fs'
import { join } from 'path'
import { createDefaultMiddleware } from '../middleware/default'
import { createSimulatedFetch, normalizeStepResult, parseSseLog } from './util'

describe('sse', async () => {
  it('simulateReadableStream', async () => {
    const result = streamText({
      model: new MockLanguageModelV2({
        doStream: async () => ({
          stream: simulateReadableStream<LanguageModelV2StreamPart>({
            initialDelayInMs: 0, // Delay before the first chunk
            chunkDelayInMs: 0, // Delay between chunks
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
      prompt: '<test>',
    })

    // Example of howto iterate over stream chunks
    // for await (const _chunk of result.fullStream) {
    //   // console.log('chunk', chunk)
    // }

    // Example of how to consume the stream (to force it to finish)
    // await result.consumeStream()
    // console.log('steps',await result.steps)

    await result.consumeStream()

    const steps = await result.steps
    const normalizedSteps = steps.map(normalizeStepResult)

    expect(normalizedSteps).toMatchSnapshot()
  })
})

describe('sse', async () => {
  const chunks = parseSseLog(fs.readFileSync(join(__dirname, 'sse-logs/banana.sse'), 'utf8'))

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
    middleware: createDefaultMiddleware(),
  })

  it('should return a readable stream', async () => {
    const result = streamText({
      model: wrappedModel,
      prompt: 'Hello, test!',
    })

    const reader = result.fullStream.getReader()

    let finalMessage
    let count = 0
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        finalMessage = value
        count++
      }
    } finally {
      reader.releaseLock()
    }

    expect(count).toBe(74)
    expect(finalMessage).toMatchSnapshot()
  })

  it('should produce identical results when running the same SSE log multiple times', async () => {
    const results = []

    for (let i = 0; i < 2; i++) {
      const chunks = parseSseLog(fs.readFileSync(join(__dirname, 'sse-logs/apple.sse'), 'utf8'))
      const simulatedFetch = createSimulatedFetch(chunks, { initialDelayInMs: 0, chunkDelayInMs: 0 })
      const provider = createOpenAICompatible({ name: 'test', baseURL: 'http://localhost:8000', fetch: simulatedFetch })
      const model = provider('test-model')
      const wrappedModel = wrapLanguageModel({ model, middleware: createDefaultMiddleware() })
      const result = streamText({ model: wrappedModel, prompt: 'test' })
      await result.consumeStream()
      results.push(await result.steps)
    }

    for (let i = 1; i < results.length; i++) {
      expect(results[i]).toEqual(results[0])
    }
  })
})
