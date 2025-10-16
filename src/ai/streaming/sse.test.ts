import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { extractReasoningMiddleware, streamText, wrapLanguageModel } from 'ai'
import { describe, expect, it } from 'bun:test'
import fs from 'fs'
import { join } from 'path'
import { createSimulatedFetch, normalizeStepResult, parseSseLog } from './util'

describe('sse', async () => {
  const chunks = parseSseLog(fs.readFileSync(join(__dirname, 'sse-logs/002-reasoning-property.sse'), 'utf8'))

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
    middleware: [extractReasoningMiddleware({ tagName: 'think', startWithReasoning: false })],
  })

  it('should return a readable stream', async () => {
    const result = streamText({
      model: wrappedModel,
      prompt: 'Hello, test!',
    })

    // Consume the stream and get the steps
    await result.consumeStream()
    const steps = await result.steps

    // Verify we got steps
    expect(steps.length).toBeGreaterThan(0)

    // Normalize and snapshot the steps
    const normalizedSteps = steps.map(normalizeStepResult)
    expect(normalizedSteps).toMatchSnapshot()
  })

  it('should produce identical results when running the same SSE log multiple times', async () => {
    const results = []

    for (let i = 0; i < 2; i++) {
      const chunks = parseSseLog(fs.readFileSync(join(__dirname, 'sse-logs/002-reasoning-property.sse'), 'utf8'))
      const simulatedFetch = createSimulatedFetch(chunks, { initialDelayInMs: 0, chunkDelayInMs: 0 })
      const provider = createOpenAICompatible({ name: 'test', baseURL: 'http://localhost:8000', fetch: simulatedFetch })
      const model = provider('test-model')
      const wrappedModel = wrapLanguageModel({
        model,
        middleware: [extractReasoningMiddleware({ tagName: 'think', startWithReasoning: false })],
      })
      const result = streamText({ model: wrappedModel, prompt: 'test' })
      await result.consumeStream()
      results.push(await result.steps)
    }

    for (let i = 1; i < results.length; i++) {
      expect(results[i]).toEqual(results[0])
    }
  })
})
