import { describe, expect, test } from 'bun:test'
import type { ToolUIPart } from 'ai'
import { createMessageAccumulator } from './message-accumulator'

describe('createMessageAccumulator', () => {
  test('accumulates text chunks into single text part', () => {
    const acc = createMessageAccumulator('msg-1')

    acc.handleUpdate({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'Hello ' },
    })

    acc.handleUpdate({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'world!' },
    })

    const msg = acc.buildMessage()
    expect(msg.id).toBe('msg-1')
    expect(msg.role).toBe('assistant')
    expect(msg.parts).toHaveLength(1)
    expect(msg.parts[0]).toEqual({ type: 'text', text: 'Hello world!' })
  })

  test('accumulates reasoning chunks into reasoning part', () => {
    const acc = createMessageAccumulator()

    acc.handleUpdate({
      sessionUpdate: 'agent_thought_chunk',
      content: { type: 'text', text: 'Let me think...' },
    })

    acc.handleUpdate({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'The answer is 42.' },
    })

    const msg = acc.buildMessage()
    expect(msg.parts).toHaveLength(2)
    expect(msg.parts[0].type).toBe('reasoning')
    expect(msg.parts[1]).toEqual({ type: 'text', text: 'The answer is 42.' })
  })

  test('tracks tool calls', () => {
    const acc = createMessageAccumulator()

    acc.handleUpdate({
      sessionUpdate: 'tool_call',
      toolCallId: 'tc-1',
      title: 'get_weather',
      kind: 'fetch',
      status: 'in_progress',
    })

    const msg1 = acc.buildMessage()
    const toolPart = msg1.parts.find((p) => p.type === 'tool-get_weather') as ToolUIPart | undefined
    expect(toolPart).toBeDefined()
    expect(toolPart?.title).toBe('get_weather')

    // Update with result
    acc.handleUpdate({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'tc-1',
      status: 'completed',
      content: [{ type: 'content', content: { type: 'text', text: 'Sunny, 72°F' } }],
    })

    const msg2 = acc.buildMessage()
    const completedToolPart = msg2.parts.find((p) => p.type === 'tool-get_weather') as ToolUIPart | undefined
    expect(completedToolPart).toBeDefined()
    expect(completedToolPart?.state).toBe('output-available')
    if (completedToolPart?.state === 'output-available') {
      expect(completedToolPart.output).toBe('Sunny, 72°F')
    }
  })

  test('handles interleaved reasoning, tools, and text', () => {
    const acc = createMessageAccumulator()

    acc.handleUpdate({
      sessionUpdate: 'agent_thought_chunk',
      content: { type: 'text', text: 'Need to search...' },
    })

    acc.handleUpdate({
      sessionUpdate: 'tool_call',
      toolCallId: 'tc-1',
      title: 'web_search',
      kind: 'search',
      status: 'in_progress',
    })

    acc.handleUpdate({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'tc-1',
      status: 'completed',
      content: [{ type: 'content', content: { type: 'text', text: 'Results found' } }],
    })

    acc.handleUpdate({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'Based on my search...' },
    })

    const msg = acc.buildMessage()
    expect(msg.parts).toHaveLength(3) // reasoning, tool, text
    expect(msg.parts[0].type).toBe('reasoning')
    expect(msg.parts[1].type).toBe('tool-web_search')
    expect(msg.parts[2].type).toBe('text')
  })

  test('hasContent is false initially', () => {
    const acc = createMessageAccumulator()
    expect(acc.hasContent).toBe(false)
  })

  test('hasContent is true after receiving content', () => {
    const acc = createMessageAccumulator()
    acc.handleUpdate({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'Hi' },
    })
    expect(acc.hasContent).toBe(true)
  })

  test('returns empty text part when no content', () => {
    const acc = createMessageAccumulator()
    const msg = acc.buildMessage()
    expect(msg.parts).toHaveLength(1)
    expect(msg.parts[0]).toEqual({ type: 'text', text: '' })
  })

  test('handleUpdate returns current message state', () => {
    const acc = createMessageAccumulator()
    const msg = acc.handleUpdate({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'Hi' },
    })
    expect(msg.parts[0]).toEqual({ type: 'text', text: 'Hi' })
  })

  test('interleaves text and tool calls across multiple steps', () => {
    const acc = createMessageAccumulator()

    // Step 1: text then tool
    acc.handleUpdate({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Let me search:' } })
    acc.handleUpdate({
      sessionUpdate: 'tool_call',
      toolCallId: 'tc1',
      title: 'Search',
      kind: 'other',
      status: 'in_progress',
    })
    acc.handleUpdate({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'tc1',
      status: 'completed',
      content: [{ type: 'content', content: { type: 'text', text: 'results' } }],
    })

    // Step 2: text then tool
    acc.handleUpdate({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Now fetching:' } })
    acc.handleUpdate({
      sessionUpdate: 'tool_call',
      toolCallId: 'tc2',
      title: 'Fetch',
      kind: 'other',
      status: 'in_progress',
    })
    acc.handleUpdate({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'tc2',
      status: 'completed',
      content: [{ type: 'content', content: { type: 'text', text: 'page content' } }],
    })

    // Final text
    acc.handleUpdate({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'Here are the results.' },
    })

    const msg = acc.buildMessage()

    // Should have 5 parts in order: text, tool, text, tool, text
    expect(msg.parts.length).toBe(5)
    expect(msg.parts[0].type).toBe('text')
    expect((msg.parts[0] as { text: string }).text).toBe('Let me search:')
    expect(msg.parts[1].type).toBe('tool-Search')
    expect(msg.parts[2].type).toBe('text')
    expect((msg.parts[2] as { text: string }).text).toBe('Now fetching:')
    expect(msg.parts[3].type).toBe('tool-Fetch')
    expect(msg.parts[4].type).toBe('text')
    expect((msg.parts[4] as { text: string }).text).toBe('Here are the results.')
  })

  test('tracks tool call timing in metadata', () => {
    const acc = createMessageAccumulator()

    acc.handleUpdate({
      sessionUpdate: 'tool_call',
      toolCallId: 'tc1',
      title: 'Search',
      kind: 'other',
      status: 'in_progress',
    })
    // Simulate some time passing
    acc.handleUpdate({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'tc1',
      status: 'completed',
      content: [{ type: 'content', content: { type: 'text', text: 'result' } }],
    })

    const msg = acc.buildMessage()
    expect(msg.metadata?.reasoningStartTimes?.tc1).toBeDefined()
    expect(msg.metadata?.reasoningTime?.tc1).toBeGreaterThanOrEqual(0)
  })
})
