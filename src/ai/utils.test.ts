import type { ThunderboltUIMessage } from '@/types'
import { describe, expect, it } from 'vitest'
import { filterIncompleteAssistantMessage } from './utils'

describe('filterIncompleteAssistantMessage', () => {
  it('returns messages unchanged when no assistant message exists', () => {
    const messages: ThunderboltUIMessage[] = [
      { id: '1', role: 'user', parts: [{ type: 'text', text: 'Hello' }] },
      { id: '2', role: 'user', parts: [{ type: 'text', text: 'How are you?' }] },
    ]

    const result = filterIncompleteAssistantMessage(messages)
    expect(result).toBe(messages) // should return same reference
  })

  it('returns messages unchanged when assistant message has completed tool calls', () => {
    const messages: ThunderboltUIMessage[] = [
      { id: '1', role: 'user', parts: [{ type: 'text', text: 'Search for cats' }] },
      {
        id: '2',
        role: 'assistant',
        parts: [
          { type: 'step-start' },
          {
            type: 'tool-search_ddg',
            toolCallId: 'call_123',
            state: 'output-available',
            input: { query: 'cats' },
            output: 'Found 3 results about cats',
          },
          { type: 'text', text: 'Here are some results about cats', state: 'done' },
        ],
      },
    ]

    const result = filterIncompleteAssistantMessage(messages)
    expect(result).toBe(messages) // should return same reference
  })

  it('removes assistant message with incomplete tool calls (input-available state)', () => {
    const messages: ThunderboltUIMessage[] = [
      { id: '1', role: 'user', parts: [{ type: 'text', text: 'Search for dogs' }] },
      {
        id: '2',
        role: 'assistant',
        parts: [
          { type: 'step-start' },
          {
            type: 'tool-search_ddg',
            toolCallId: 'call_456',
            state: 'input-available', // incomplete state
            input: { query: 'dogs' },
          },
        ],
      },
      { id: '3', role: 'user', parts: [{ type: 'text', text: 'What happened?' }] },
    ]

    const result = filterIncompleteAssistantMessage(messages)
    expect(result).toEqual([{ id: '1', role: 'user', parts: [{ type: 'text', text: 'Search for dogs' }] }])
  })

  it('removes assistant message with incomplete tool calls (input-streaming state)', () => {
    const messages: ThunderboltUIMessage[] = [
      { id: '1', role: 'user', parts: [{ type: 'text', text: 'Check calendar' }] },
      {
        id: '2',
        role: 'assistant',
        parts: [
          { type: 'step-start' },
          {
            type: 'tool-google_check_calendar',
            toolCallId: 'call_789',
            state: 'input-streaming', // incomplete state
            input: { days_ahead: 7 },
          },
        ],
      },
    ]

    const result = filterIncompleteAssistantMessage(messages)
    expect(result).toEqual([{ id: '1', role: 'user', parts: [{ type: 'text', text: 'Check calendar' }] }])
  })

  it('handles multiple assistant messages, only checking the most recent one', () => {
    const messages: ThunderboltUIMessage[] = [
      { id: '1', role: 'user', parts: [{ type: 'text', text: 'First question' }] },
      {
        id: '2',
        role: 'assistant',
        parts: [
          {
            type: 'tool-search_ddg',
            toolCallId: 'call_old',
            state: 'input-available', // incomplete, but not the most recent
            input: { query: 'old search' },
          },
        ],
      },
      { id: '3', role: 'user', parts: [{ type: 'text', text: 'Second question' }] },
      {
        id: '4',
        role: 'assistant',
        parts: [
          {
            type: 'tool-search_ddg',
            toolCallId: 'call_new',
            state: 'output-available', // complete
            input: { query: 'new search' },
            output: 'Results found',
          },
          { type: 'text', text: 'Here are the results', state: 'done' },
        ],
      },
    ]

    const result = filterIncompleteAssistantMessage(messages)
    expect(result).toBe(messages) // should return same reference since most recent is complete
  })

  it('removes most recent incomplete assistant and subsequent messages', () => {
    const messages: ThunderboltUIMessage[] = [
      { id: '1', role: 'user', parts: [{ type: 'text', text: 'First question' }] },
      {
        id: '2',
        role: 'assistant',
        parts: [
          {
            type: 'tool-search_ddg',
            toolCallId: 'call_complete',
            state: 'output-available',
            input: { query: 'complete search' },
            output: 'Results',
          },
          { type: 'text', text: 'First answer', state: 'done' },
        ],
      },
      { id: '3', role: 'user', parts: [{ type: 'text', text: 'Second question' }] },
      {
        id: '4',
        role: 'assistant',
        parts: [
          {
            type: 'tool-search_ddg',
            toolCallId: 'call_incomplete',
            state: 'input-available', // incomplete
            input: { query: 'incomplete search' },
          },
        ],
      },
      { id: '5', role: 'user', parts: [{ type: 'text', text: 'Follow-up question' }] },
    ]

    const result = filterIncompleteAssistantMessage(messages)
    expect(result).toEqual([
      { id: '1', role: 'user', parts: [{ type: 'text', text: 'First question' }] },
      {
        id: '2',
        role: 'assistant',
        parts: [
          {
            type: 'tool-search_ddg',
            toolCallId: 'call_complete',
            state: 'output-available',
            input: { query: 'complete search' },
            output: 'Results',
          },
          { type: 'text', text: 'First answer', state: 'done' },
        ],
      },
      { id: '3', role: 'user', parts: [{ type: 'text', text: 'Second question' }] },
    ])
  })

  it('handles empty messages array', () => {
    const messages: ThunderboltUIMessage[] = []
    const result = filterIncompleteAssistantMessage(messages)
    expect(result).toBe(messages) // should return same reference
  })

  it('handles assistant message with mixed tool states (incomplete wins)', () => {
    const messages: ThunderboltUIMessage[] = [
      { id: '1', role: 'user', parts: [{ type: 'text', text: 'Multi-tool request' }] },
      {
        id: '2',
        role: 'assistant',
        parts: [
          { type: 'step-start' },
          {
            type: 'tool-search_ddg',
            toolCallId: 'call_complete',
            state: 'output-available',
            input: { query: 'complete' },
            output: 'Done',
          },
          {
            type: 'tool-google_check_calendar',
            toolCallId: 'call_incomplete',
            state: 'input-available', // this makes the whole message incomplete
            input: { days_ahead: 1 },
          },
        ],
      },
    ]

    const result = filterIncompleteAssistantMessage(messages)
    expect(result).toEqual([{ id: '1', role: 'user', parts: [{ type: 'text', text: 'Multi-tool request' }] }])
  })
})
