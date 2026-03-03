import { describe, expect, it } from 'bun:test'
import { renderHook } from '@testing-library/react'
import { useStreamingHaptics } from './use-streaming-haptics'

const createMessage = (text: string) => ({
  id: 'msg-1',
  role: 'assistant' as const,
  parts: [{ type: 'text' as const, text }],
})

describe('useStreamingHaptics', () => {
  it('does not throw when called with empty messages', () => {
    expect(() => {
      renderHook(() => useStreamingHaptics([], 'ready'))
    }).not.toThrow()
  })

  it('does not throw when called with streaming messages', () => {
    const messages = [createMessage('Hello')]
    expect(() => {
      renderHook(() => useStreamingHaptics(messages, 'streaming'))
    }).not.toThrow()
  })
})
