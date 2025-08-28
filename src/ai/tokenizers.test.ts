import type { ThunderboltUIMessage } from '@/types'
import { describe, expect, it } from 'vitest'
import { estimateTokensForMessages, estimateTokensForText, formatTokenCount } from './tokenizers'

describe('tokenizers', () => {
  describe('estimateTokensForText', () => {
    it('should estimate tokens for simple text', () => {
      const text = 'Hello, world!'
      const tokens = estimateTokensForText(text)
      expect(tokens).toBeGreaterThan(0)
      expect(tokens).toBeLessThan(text.length) // Should be less than character count
    })

    it('should return 0 for empty text', () => {
      expect(estimateTokensForText('')).toBe(0)
    })

    it('should estimate reasonable token counts', () => {
      const shortText = 'Hi'
      const longText = 'This is a much longer piece of text that should result in more tokens than the short text.'

      const shortTokens = estimateTokensForText(shortText)
      const longTokens = estimateTokensForText(longText)

      expect(longTokens).toBeGreaterThan(shortTokens)
      expect(shortTokens).toBe(1) // "Hi" should be about 1 token
      expect(longTokens).toBeGreaterThan(15) // Long text should be many tokens
    })
  })

  describe('estimateTokensForMessages', () => {
    it('should estimate tokens for multiple messages', () => {
      const messages: ThunderboltUIMessage[] = [
        {
          id: '1',
          role: 'user',
          parts: [{ type: 'text', text: 'Hello, how are you?' }],
        },
        {
          id: '2',
          role: 'assistant',
          parts: [{ type: 'text', text: 'I am doing well, thank you for asking!' }],
        },
      ] as ThunderboltUIMessage[]

      const tokens = estimateTokensForMessages(messages)
      expect(tokens).toBeGreaterThan(0)
      expect(tokens).toBeGreaterThan(estimateTokensForText('Hello, how are you?')) // Should include overhead
    })

    it('should include tool invocations in token count', () => {
      const messages: ThunderboltUIMessage[] = [
        {
          id: '1',
          role: 'user',
          parts: [{ type: 'text', text: 'Search for information' }],
        },
        {
          id: '2',
          role: 'assistant',
          parts: [
            { type: 'text', text: 'I will search for that.' },
            {
              type: 'tool-call',
              toolCallId: 'call_123',
              toolName: 'search',
              args: { query: 'test query' },
            } as any,
          ],
        },
      ] as ThunderboltUIMessage[]

      const tokens = estimateTokensForMessages(messages)
      expect(tokens).toBeGreaterThan(0)
      // Should include the tool call in the count
      const toolCallText = JSON.stringify({
        type: 'tool-call',
        toolCallId: 'call_123',
        toolName: 'search',
        args: { query: 'test query' },
      })
      const expectedMinTokens =
        estimateTokensForText('Search for information') +
        estimateTokensForText('I will search for that.') +
        estimateTokensForText(toolCallText)
      expect(tokens).toBeGreaterThan(expectedMinTokens)
    })

    it('should return 0 for empty messages array', () => {
      expect(estimateTokensForMessages([])).toBe(0)
    })

    it('should include overhead for system prompts and formatting', () => {
      const messages: ThunderboltUIMessage[] = [
        {
          id: '1',
          role: 'user',
          parts: [{ type: 'text', text: 'Hi' }],
        },
      ] as ThunderboltUIMessage[]

      const tokens = estimateTokensForMessages(messages)
      const textOnlyTokens = estimateTokensForText('Hi')

      expect(tokens).toBeGreaterThan(textOnlyTokens + 100) // Should include significant overhead
    })
  })

  describe('deterministic token counting', () => {
    it('should return consistent counts for the same input', () => {
      const text = 'This is a test message for consistent token counting.'
      const count1 = estimateTokensForText(text)
      const count2 = estimateTokensForText(text)
      expect(count1).toBe(count2)
    })

    it('should return consistent counts for the same messages', () => {
      const messages: ThunderboltUIMessage[] = [
        {
          id: '1',
          role: 'user',
          parts: [{ type: 'text', text: 'Test message' }],
        },
      ] as ThunderboltUIMessage[]

      const count1 = estimateTokensForMessages(messages)
      const count2 = estimateTokensForMessages(messages)
      expect(count1).toBe(count2)
    })
  })

  describe('formatTokenCount', () => {
    it('should format used/max token counts', () => {
      expect(formatTokenCount(1000, 256000)).toBe('1K / 256K')
      expect(formatTokenCount(50000, 1000000)).toBe('50K / 1M')
      expect(formatTokenCount(750, 2000)).toBe('750 / 2K')
    })

    it('should handle undefined max tokens', () => {
      expect(formatTokenCount(1000)).toBe('1K / unknown')
      expect(formatTokenCount(50000, undefined)).toBe('50K / unknown')
    })

    it('should handle zero values', () => {
      expect(formatTokenCount(0, 256000)).toBe('0 / 256K')
      expect(formatTokenCount(1000, 0)).toBe('1K / 0')
    })
  })
})
