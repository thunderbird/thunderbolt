import type { LanguageModelV2StreamPart } from '@ai-sdk/provider'
import { describe, expect, it } from 'bun:test'
import { toolCallsMiddleware } from './tool-calls'

// Helper to create a ReadableStream of text parts
const createTextStream = (tokens: string[]): ReadableStream<LanguageModelV2StreamPart> => {
  return new ReadableStream({
    start(controller) {
      for (const token of tokens) {
        controller.enqueue({ type: 'text', text: token } as any)
      }
      controller.close()
    },
  })
}

// Utility to convert the `args` payload into an object regardless of whether the
// middleware returns it as a string (production behaviour) or as an already
// parsed object (legacy behaviour).
const parseArgs = (args: unknown): any => {
  if (typeof args === 'string') {
    try {
      return JSON.parse(args)
    } catch {
      return { raw: args }
    }
  }
  return args
}

describe('toolCallsMiddleware', () => {
  // (No console output required during tests)

  it('parses Kimi-K2 style tool call blocks', async () => {
    const tokens = [
      '<',
      '|',
      'tool',
      '_calls',
      '_section',
      '_begin',
      '|',
      '>',
      '<',
      '|',
      'tool',
      '_call',
      '_begin',
      '|',
      '>',
      'functions',
      '.search',
      ':',
      '0',
      '<',
      '|',
      'tool',
      '_call',
      '_argument',
      '_begin',
      '|',
      '>',
      '{"max_results":8,"query":"latest news"}',
      '<',
      '|',
      'tool',
      '_call',
      '_end',
      '|',
      '>',
      '<',
      '|',
      'tool',
      '_calls',
      '_section',
      '_end',
      '|',
      '>',
    ]

    const inputStream = createTextStream(tokens)

    const { stream } = await (toolCallsMiddleware.wrapStream as any)({
      doStream: async () => ({ stream: inputStream }),
    })

    const parts: any[] = []
    const reader = stream.getReader()
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      parts.push(value)
    }

    const toolCallPart = parts.find((p) => p.type === 'tool-call')
    expect(toolCallPart).toBeDefined()
    expect(toolCallPart.toolName).toBe('search')
    expect(parseArgs(toolCallPart.args)).toEqual({ max_results: 8, query: 'latest news' })
  })

  it('parses real-world Kimi-K2 tool calls from Fireworks', async () => {
    // This test uses the exact token sequence from the real response
    const tokens = [
      '<|tool_calls_section_begin|>',
      '<|tool_call_begin|>',
      'functions.search:1',
      '<|tool_call_argument_begin|>',
      '{"max_results":10,"query":"breaking news today"}',
      '<|tool_call_end|>',
      '<|tool_calls_section_end|>',
    ]

    const inputStream = createTextStream(tokens)

    const { stream } = await (toolCallsMiddleware.wrapStream as any)({
      doStream: async () => ({ stream: inputStream }),
    })

    const parts: any[] = []
    const reader = stream.getReader()
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      parts.push(value)
    }

    // Should not have any text parts with tool call tokens
    const textParts = parts.filter((p) => p.type === 'text')
    textParts.forEach((part) => {
      expect(part.text).not.toContain('tool_call')
      expect(part.text).not.toContain('<|')
      expect(part.text).not.toContain('|>')
    })

    // Should have exactly one tool call
    const toolCallParts = parts.filter((p) => p.type === 'tool-call')
    expect(toolCallParts).toHaveLength(1)

    const toolCall = toolCallParts[0]
    expect(toolCall.toolName).toBe('search')
    expect(toolCall.toolCallId).toBe('1')
    expect(parseArgs(toolCall.args)).toEqual({ max_results: 10, query: 'breaking news today' })
  })

  it('handles tool calls mixed with regular text', async () => {
    const tokens = [
      'Let me search for that information.',
      '<|tool_calls_section_begin|>',
      '<|tool_call_begin|>',
      'functions.search:1',
      '<|tool_call_argument_begin|>',
      '{"query":"test"}',
      '<|tool_call_end|>',
      '<|tool_calls_section_end|>',
      'Based on the search results...',
    ]

    const inputStream = createTextStream(tokens)

    const { stream } = await (toolCallsMiddleware.wrapStream as any)({
      doStream: async () => ({ stream: inputStream }),
    })

    const parts: any[] = []
    const reader = stream.getReader()
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      parts.push(value)
    }

    // Check text parts are properly consolidated
    const textParts = parts.filter((p) => p.type === 'text')
    expect(textParts).toHaveLength(2)
    expect(textParts[0].text).toBe('Let me search for that information.')
    expect(textParts[1].text).toBe('Based on the search results...')

    // Check tool call
    const toolCallParts = parts.filter((p) => p.type === 'tool-call')
    expect(toolCallParts).toHaveLength(1)
    expect(toolCallParts[0].toolName).toBe('search')
  })

  it('handles tool calls that come as individual character tokens (real Fireworks scenario)', async () => {
    // This mimics the exact scenario from the Fireworks API response
    const tokens = [
      '<',
      '|',
      'tool',
      '_calls',
      '_section',
      '_begin',
      '|',
      '>',
      '<',
      '|',
      'tool',
      '_call',
      '_begin',
      '|',
      '>',
      'functions',
      '.search',
      ':',
      '1',
      '<',
      '|',
      'tool',
      '_call',
      '_argument',
      '_begin',
      '|',
      '>',
      '{"',
      'max',
      '_results',
      '":',
      '10',
      ',"',
      'query',
      '":"',
      'breaking',
      ' news',
      ' today',
      '"}',
      '<',
      '|',
      'tool',
      '_call',
      '_end',
      '|',
      '>',
      '<',
      '|',
      'tool',
      '_calls',
      '_section',
      '_end',
      '|',
      '>',
    ]

    const inputStream = createTextStream(tokens)

    const { stream } = await (toolCallsMiddleware.wrapStream as any)({
      doStream: async () => ({ stream: inputStream }),
    })

    const parts: any[] = []
    const reader = stream.getReader()
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      parts.push(value)
    }

    // Should have exactly one tool call and no text containing tool call tokens
    const textParts = parts.filter((p) => p.type === 'text')
    textParts.forEach((part) => {
      expect(part.text).not.toContain('tool_call')
      expect(part.text).not.toContain('<|')
      expect(part.text).not.toContain('|>')
    })

    const toolCallParts = parts.filter((p) => p.type === 'tool-call')
    expect(toolCallParts).toHaveLength(1)

    const toolCall = toolCallParts[0]
    expect(toolCall.toolName).toBe('search')
    expect(toolCall.toolCallId).toBe('1')
    expect(parseArgs(toolCall.args)).toEqual({ max_results: 10, query: 'breaking news today' })
  })

  it('handles the exact failing scenario from Fireworks Kimi-K2', async () => {
    // Exact token sequence that was causing tool call tokens to leak into text
    const tokens = [
      '<',
      '|',
      'tool',
      '_calls',
      '_section',
      '_begin',
      '|',
      '>',
      '<',
      '|',
      'tool',
      '_call',
      '_begin',
      '|',
      '>',
      'functions',
      '.search',
      ':',
      '1',
      '<',
      '|',
      'tool',
      '_call',
      '_argument',
      '_begin',
      '|',
      '>',
      '{"',
      'max',
      '_results',
      '":',
      '10',
      ',"',
      'query',
      '":"',
      'breaking',
      ' news',
      ' today',
      '"}',
      '<',
      '|',
      'tool',
      '_call',
      '_end',
      '|',
      '>',
      '<',
      '|',
      'tool',
      '_calls',
      '_section',
      '_end',
      '|',
      '>',
    ]

    const inputStream = createTextStream(tokens)

    const { stream } = await (toolCallsMiddleware.wrapStream as any)({
      doStream: async () => ({ stream: inputStream }),
    })

    const parts: any[] = []
    const reader = stream.getReader()
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      parts.push(value)
    }

    // This is the key test: NO text parts should contain tool call tokens
    const textParts = parts.filter((p) => p.type === 'text')
    textParts.forEach((part) => {
      expect(part.text).not.toContain('<|')
      expect(part.text).not.toContain('|>')
      expect(part.text).not.toContain('tool_call')
      expect(part.text).not.toContain('functions.')
    })

    // Should have exactly one properly parsed tool call
    const toolCallParts = parts.filter((p) => p.type === 'tool-call')
    expect(toolCallParts).toHaveLength(1)

    const toolCall = toolCallParts[0]
    expect(toolCall.toolName).toBe('search')
    expect(toolCall.toolCallId).toBe('1')
    expect(parseArgs(toolCall.args)).toEqual({ max_results: 10, query: 'breaking news today' })
  })

  it('handles the exact failing case with max_results (no underscores in JSON)', async () => {
    // Exact token sequence from the user's failing request
    const tokens = [
      '<',
      '|',
      'tool',
      '_calls',
      '_section',
      '_begin',
      '|',
      '>',
      '<',
      '|',
      'tool',
      '_call',
      '_begin',
      '|',
      '>',
      'functions',
      '.search',
      ':',
      '1',
      '<',
      '|',
      'tool',
      '_call',
      '_argument',
      '_begin',
      '|',
      '>',
      '{"',
      'max',
      '_results', // Note: this is max_results, not maxresults
      '":',
      '8',
      ',"',
      'query',
      '":"',
      'breaking',
      ' news',
      ' July',
      ' ',
      '16',
      ' ',
      '202',
      '5',
      '"}',
      '<',
      '|',
      'tool',
      '_call',
      '_end',
      '|',
      '>',
      '<',
      '|',
      'tool',
      '_calls',
      '_section',
      '_end',
      '|',
      '>',
    ]

    const inputStream = createTextStream(tokens)

    const { stream } = await (toolCallsMiddleware.wrapStream as any)({
      doStream: async () => ({ stream: inputStream }),
    })

    const parts: any[] = []
    const reader = stream.getReader()
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      parts.push(value)
    }

    // This is the key test: NO text parts should contain tool call tokens
    const textParts = parts.filter((p) => p.type === 'text')
    textParts.forEach((part) => {
      expect(part.text).not.toContain('<|')
      expect(part.text).not.toContain('|>')
      expect(part.text).not.toContain('tool_call')
      expect(part.text).not.toContain('functions.')
    })

    // Should have exactly one properly parsed tool call
    const toolCallParts = parts.filter((p) => p.type === 'tool-call')
    expect(toolCallParts).toHaveLength(1)

    const toolCall = toolCallParts[0]
    expect(toolCall.toolName).toBe('search')
    expect(toolCall.toolCallId).toBe('1')
    expect(parseArgs(toolCall.args)).toEqual({ max_results: 8, query: 'breaking news July 16 2025' })
  })

  it('handles the exact failing token sequence from user error report', async () => {
    // The exact token sequence from the failing request that caused ".trim is not a function"
    const tokens = [
      '<',
      '|',
      'tool',
      '_calls',
      '_section',
      '_begin',
      '|',
      '>',
      '<',
      '|',
      'tool',
      '_call',
      '_begin',
      '|',
      '>',
      'functions',
      '.search',
      ':',
      '0',
      '<',
      '|',
      'tool',
      '_call',
      '_argument',
      '_begin',
      '|',
      '>',
      '{"',
      'max',
      '_results',
      '":',
      '8',
      ',"',
      'query',
      '":"',
      'breaking',
      ' news',
      ' today',
      '"}',
      '<',
      '|',
      'tool',
      '_call',
      '_end',
      '|',
      '>',
      '<',
      '|',
      'tool',
      '_calls',
      '_section',
      '_end',
      '|',
      '>',
    ]

    const inputStream = createTextStream(tokens)

    const { stream } = await (toolCallsMiddleware.wrapStream as any)({
      doStream: async () => ({ stream: inputStream }),
    })

    const parts: any[] = []
    const reader = stream.getReader()
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      parts.push(value)
    }

    // Verify the tool call args are properly parsed as an object
    const toolCallParts = parts.filter((p) => p.type === 'tool-call')
    expect(toolCallParts).toHaveLength(1)

    const toolCall = toolCallParts[0]
    expect(toolCall.toolName).toBe('search')
    expect(toolCall.toolCallId).toBe('0')
    expect(parseArgs(toolCall.args)).toEqual({ max_results: 8, query: 'breaking news today' })

    // Args should be a JSON string and parseable into the expected object
    expect(typeof toolCall.args).toBe('string')
  })

  it('handles malformed JSON arguments without causing .trim() errors', async () => {
    // Test case where JSON parsing fails - this should not cause .trim() errors
    const tokens = [
      '<|tool_calls_section_begin|>',
      '<|tool_call_begin|>',
      'functions.search:0',
      '<|tool_call_argument_begin|>',
      'invalid json { broken', // This will fail JSON.parse()
      '<|tool_call_end|>',
      '<|tool_calls_section_end|>',
    ]

    const inputStream = createTextStream(tokens)

    const { stream } = await (toolCallsMiddleware.wrapStream as any)({
      doStream: async () => ({ stream: inputStream }),
    })

    const parts: any[] = []
    const reader = stream.getReader()
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      parts.push(value)
    }

    // Should still create a tool call with args as an object
    const toolCallParts = parts.filter((p) => p.type === 'tool-call')
    expect(toolCallParts).toHaveLength(1)

    const toolCall = toolCallParts[0]
    expect(toolCall.toolName).toBe('search')
    expect(toolCall.toolCallId).toBe('0')

    // Args should be a string, but our helper should convert it into the fallback object
    expect(typeof toolCall.args).toBe('string')
    expect(parseArgs(toolCall.args)).toEqual({ raw: 'invalid json { broken' })
  })

  // (Removed two legacy reproduction tests that used a throw-away middleware implementation)

  it('maintains streaming for regular text without tool calls', async () => {
    // Test that regular text streams properly without waiting for tool sections
    const tokens = [
      'Hello',
      ' there',
      '! This',
      ' is',
      ' a',
      ' regular',
      ' text',
      ' message',
      ' without',
      ' any',
      ' tool',
      ' calls.',
      ' It',
      ' should',
      ' stream',
      ' properly',
      ' and',
      ' not',
      ' accumulate',
      ' in',
      ' the',
      ' buffer.',
    ]

    const inputStream = createTextStream(tokens)

    const { stream } = await (toolCallsMiddleware.wrapStream as any)({
      doStream: async () => ({ stream: inputStream }),
    })

    const parts: any[] = []
    const reader = stream.getReader()
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      parts.push(value)
    }

    // Should have streaming text parts, not just one big accumulated part
    const textParts = parts.filter((p) => p.type === 'text')
    expect(textParts.length).toBeGreaterThan(1) // Should be multiple streaming parts

    // No tool calls should be detected
    const toolCallParts = parts.filter((p) => p.type === 'tool-call')
    expect(toolCallParts.length).toBe(0)

    // Total text should be correct
    const totalText = textParts.map((p) => p.text).join('')
    expect(totalText).toBe(
      'Hello there! This is a regular text message without any tool calls. It should stream properly and not accumulate in the buffer.',
    )
  })

  it('ignores duplicate tool_call_end tokens so they do not leak into text', async () => {
    const tokens = [
      '<|tool_calls_section_begin|>',
      '<|tool_call_begin|>',
      'functions.search:1',
      '<|tool_call_argument_begin|>',
      '{"query":"foo"}',
      '<|tool_call_end|>',
      '<|tool_call_end|>', // stray duplicate
      '<|tool_calls_section_end|>',
      'Done.',
    ]

    const inputStream = createTextStream(tokens)

    const { stream } = await (toolCallsMiddleware.wrapStream as any)({
      doStream: async () => ({ stream: inputStream }),
    })

    const parts: any[] = []
    const reader = stream.getReader()
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      parts.push(value)
    }

    const textParts = parts.filter((p) => p.type === 'text')
    // Text should be exactly 'Done.' with no leaked tokens
    expect(textParts.length).toBe(1)
    expect(textParts[0].text).toBe('Done.')

    const toolCallParts = parts.filter((p) => p.type === 'tool-call')
    expect(toolCallParts).toHaveLength(1)
    expect(toolCallParts[0].toolName).toBe('search')
  })
})
