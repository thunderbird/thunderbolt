import { describe, it, expect } from 'vitest'
import { tokenizerService } from './tokenizer'
import type { ThunderboltUIMessage } from '@/types'

describe('TokenizerService', () => {
  describe('getContextLimit', () => {
    it('should return correct limits for known models', () => {
      expect(tokenizerService.getContextLimit('gpt-4')).toBe(8192)
      expect(tokenizerService.getContextLimit('gpt-4o')).toBe(128000)
      expect(tokenizerService.getContextLimit('claude-3-opus-20240229')).toBe(200000)
      expect(tokenizerService.getContextLimit('mistral-large-latest')).toBe(128000)
      expect(tokenizerService.getContextLimit('qwen/qwen-2.5-72b-instruct')).toBe(128000)
    })

    it('should return default limit for unknown models', () => {
      expect(tokenizerService.getContextLimit('unknown-model')).toBe(8192)
    })

    it('should handle partial matches', () => {
      expect(tokenizerService.getContextLimit('custom-gpt-4-turbo-variant')).toBe(128000)
    })
  })

  describe('countTokens', () => {
    it('should count tokens for OpenAI models', async () => {
      const text = 'Hello, world! This is a test message.'
      const tokenCount = await tokenizerService.countTokens(text, 'gpt-4', 'openai')

      // GPT-4 tokenizer should produce around 9-10 tokens for this text
      expect(tokenCount).toBeGreaterThan(5)
      expect(tokenCount).toBeLessThan(15)
    })

    it('should count tokens for simple text consistently', async () => {
      const text = 'The quick brown fox jumps over the lazy dog.'

      const count1 = await tokenizerService.countTokens(text, 'gpt-4', 'openai')
      const count2 = await tokenizerService.countTokens(text, 'gpt-4', 'openai')

      // Should be consistent
      expect(count1).toBe(count2)

      // Should be reasonable (around 9-11 tokens)
      expect(count1).toBeGreaterThan(8)
      expect(count1).toBeLessThan(12)
    })

    it('should handle empty text', async () => {
      const tokenCount = await tokenizerService.countTokens('', 'gpt-4', 'openai')
      expect(tokenCount).toBe(0)
    })

    it('should handle long text', async () => {
      const longText = 'Lorem ipsum dolor sit amet. '.repeat(100)
      const tokenCount = await tokenizerService.countTokens(longText, 'gpt-4', 'openai')

      // Should be proportional to text length
      expect(tokenCount).toBeGreaterThan(100)
      expect(tokenCount).toBeLessThan(1000)
    })
  })

  describe('countChatTokens', () => {
    it('should count tokens for chat messages with overhead', async () => {
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
      ]

      const tokenCount = await tokenizerService.countChatTokens(messages, 'gpt-4', 'openai')

      // Should include message content + overhead
      expect(tokenCount).toBeGreaterThan(10)
      expect(tokenCount).toBeLessThan(50)
    })

    it('should include system prompt in token count', async () => {
      const messages: ThunderboltUIMessage[] = [
        {
          id: '1',
          role: 'user',
          parts: [{ type: 'text', text: 'Hi' }],
        },
      ]

      const systemPrompt = 'You are a helpful assistant.'

      const countWithoutSystem = await tokenizerService.countChatTokens(messages, 'gpt-4', 'openai')

      const countWithSystem = await tokenizerService.countChatTokens(messages, 'gpt-4', 'openai', systemPrompt)

      expect(countWithSystem).toBeGreaterThan(countWithoutSystem)
    })
  })

  describe('validateTokenLimit', () => {
    it('should validate when within limit', async () => {
      const messages: ThunderboltUIMessage[] = [
        {
          id: '1',
          role: 'user',
          parts: [{ type: 'text', text: 'Short message' }],
        },
      ]

      const result = await tokenizerService.validateTokenLimit(messages, 'gpt-4', 'openai')

      expect(result.valid).toBe(true)
      expect(result.tokenCount).toBeGreaterThan(0)
      expect(result.limit).toBe(8192)
    })

    it('should reject when exceeding limit', async () => {
      // Create a very long message that will exceed the limit
      const veryLongContent = 'This is a test message. '.repeat(5000)

      const messages: ThunderboltUIMessage[] = [
        {
          id: '1',
          role: 'user',
          parts: [{ type: 'text', text: veryLongContent }],
        },
      ]

      const result = await tokenizerService.validateTokenLimit(
        messages,
        'gpt-4',
        'openai',
        undefined,
        1000, // Reserve only 1000 tokens for response
      )

      expect(result.valid).toBe(false)
      expect(result.message).toContain('exceeded the maximum token limit')
      expect(result.tokenCount).toBeGreaterThan(result.limit - 1000)
    })

    it('should handle tool invocations in messages', async () => {
      const messageWithTools: ThunderboltUIMessage = {
        id: '1',
        role: 'assistant',
        parts: [
          { type: 'text', text: 'Let me search for that.' },
          {
            type: 'tool-call',
            toolCallId: 'call1',
            // Tool parts have complex structures, we just need to test they add tokens
          } as any,
        ],
      }

      const messagesWithoutTools: ThunderboltUIMessage[] = [
        {
          id: '1',
          role: 'assistant',
          parts: [{ type: 'text', text: 'Let me search for that.' }],
        },
      ]

      const messagesWithTools: ThunderboltUIMessage[] = [messageWithTools]

      const countWithout = await tokenizerService.countChatTokens(messagesWithoutTools, 'gpt-4', 'openai')

      const countWith = await tokenizerService.countChatTokens(messagesWithTools, 'gpt-4', 'openai')

      // Tool invocations should add tokens
      expect(countWith).toBeGreaterThan(countWithout)
    })
  })

  describe('Fallback behavior', () => {
    it('should use fallback estimation for unknown providers', async () => {
      const text = 'Test message for fallback'
      const tokenCount = await tokenizerService.countTokens(text, 'unknown-model', 'unknown-provider')

      // Fallback uses character count / 4
      expect(tokenCount).toBe(Math.ceil(text.length / 4))
    })
  })
})
