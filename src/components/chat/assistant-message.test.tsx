// @ts-ignore - Bun test types are provided at runtime
import { describe, expect, it } from 'bun:test'
import type { UIMessage } from 'ai'

// Mock React components for testing logic
const mockReasoningPart = (isStreaming: boolean) => ({ isStreaming })
const mockTextPart = (isStreaming: boolean) => ({ isStreaming })

// Extract the logic from AssistantMessage for testing
function determineReasoningStreamingState(
  message: UIMessage, 
  isStreaming: boolean
): boolean {
  const filteredParts = message.parts.filter((part) => ['reasoning', 'tool-invocation', 'text'].includes(part.type))
  const reasoningParts = filteredParts.filter(part => part.type === 'reasoning')
  const nonReasoningParts = filteredParts.filter(part => part.type !== 'reasoning')
  
  // Current logic (which we expect to be wrong)
  return isStreaming && reasoningParts.length > 0
}

// Correct logic (what we want to implement)
function correctReasoningStreamingState(
  message: UIMessage, 
  isStreaming: boolean
): boolean {
  const filteredParts = message.parts.filter((part) => ['reasoning', 'tool-invocation', 'text'].includes(part.type))
  const reasoningParts = filteredParts.filter(part => part.type === 'reasoning')
  const textParts = filteredParts.filter(part => part.type === 'text')
  
  // Reasoning is streaming only if:
  // 1. Overall stream is active AND
  // 2. We have reasoning parts AND
  // 3. We don't have any text parts yet (meaning reasoning hasn't finished)
  return isStreaming && reasoningParts.length > 0 && textParts.length === 0
}

describe('AssistantMessage reasoning streaming logic', () => {
  it('should show reasoning as NOT streaming when text parts are present (reasoning has finished)', () => {
    const messageWithReasoningAndText: UIMessage = {
      id: 'test-msg',
      role: 'assistant',
      parts: [
        {
          type: 'reasoning',
          text: 'I need to think about this carefully...'
        } as any,
        {
          type: 'text',
          text: 'Here is my response'
        } as any
      ]
    }

    // Current logic (wrong) - shows as streaming when it shouldn't
    const currentResult = determineReasoningStreamingState(messageWithReasoningAndText, true)
    expect(currentResult).toBe(true) // This is the bug!
    
    // Correct logic - should not be streaming when text parts exist
    const correctResult = correctReasoningStreamingState(messageWithReasoningAndText, true)
    expect(correctResult).toBe(false) // This is what we want
  })

  it('should show reasoning as streaming when only reasoning parts are present', () => {
    const messageWithOnlyReasoning: UIMessage = {
      id: 'test-msg',
      role: 'assistant',
      parts: [
        {
          type: 'reasoning',
          text: 'I need to think about this carefully...'
        } as any
      ]
    }

    // Both should agree when only reasoning is present
    const currentResult = determineReasoningStreamingState(messageWithOnlyReasoning, true)
    const correctResult = correctReasoningStreamingState(messageWithOnlyReasoning, true)
    
    expect(currentResult).toBe(true)
    expect(correctResult).toBe(true)
  })

  it('should show reasoning as NOT streaming when stream is not active', () => {
    const messageWithReasoning: UIMessage = {
      id: 'test-msg',
      role: 'assistant',
      parts: [
        {
          type: 'reasoning',
          text: 'I need to think about this carefully...'
        } as any
      ]
    }

    // Both should agree when stream is not active
    const currentResult = determineReasoningStreamingState(messageWithReasoning, false)
    const correctResult = correctReasoningStreamingState(messageWithReasoning, false)
    
    expect(currentResult).toBe(false)
    expect(correctResult).toBe(false)
  })
})