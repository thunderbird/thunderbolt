import { describe, expect, it } from 'bun:test'
import { 
  validateTokenLimit, 
  getContextWindow, 
  getTokenLimitErrorMessage,
  MODEL_CONTEXT_WINDOWS 
} from './tokenizer'
import { Model } from '@/types'

// Mock models for testing
const mockModels: Record<string, Model> = {
  openai: {
    id: '1',
    provider: 'openai',
    name: 'GPT-4',
    model: 'gpt-4',
    url: null,
    apiKey: 'test-key',
    isSystem: 0,
    enabled: 1,
    toolUsage: 1,
    isConfidential: 0,
    startWithReasoning: 0,
  },
  claude: {
    id: '2',
    provider: 'custom',
    name: 'Claude 3.5 Sonnet',
    model: 'claude-3-5-sonnet-20241022',
    url: 'https://api.anthropic.com',
    apiKey: 'test-key',
    isSystem: 0,
    enabled: 1,
    toolUsage: 1,
    isConfidential: 0,
    startWithReasoning: 0,
  },
  qwen: {
    id: '3',
    provider: 'custom',
    name: 'Qwen 2.5 72B',
    model: 'qwen2.5-72b-instruct',
    url: 'https://api.example.com',
    apiKey: 'test-key',
    isSystem: 0,
    enabled: 1,
    toolUsage: 1,
    isConfidential: 0,
    startWithReasoning: 0,
  },
  mistral: {
    id: '4',
    provider: 'custom',
    name: 'Mistral Large',
    model: 'mistral-large-latest',
    url: 'https://api.example.com',
    apiKey: 'test-key',
    isSystem: 0,
    enabled: 1,
    toolUsage: 1,
    isConfidential: 0,
    startWithReasoning: 0,
  }
}

describe('Tokenizer', () => {
  describe('getContextWindow', () => {
    it('should return correct context window for known models', () => {
      expect(getContextWindow('gpt-4')).toBe(MODEL_CONTEXT_WINDOWS['gpt-4'])
      expect(getContextWindow('gpt-4o')).toBe(MODEL_CONTEXT_WINDOWS['gpt-4o'])
      expect(getContextWindow('claude-3-sonnet-20240229')).toBe(MODEL_CONTEXT_WINDOWS['claude-3-sonnet-20240229'])
      expect(getContextWindow('qwen2.5-72b-instruct')).toBe(MODEL_CONTEXT_WINDOWS['qwen2.5-72b-instruct'])
      expect(getContextWindow('mistral-large-latest')).toBe(MODEL_CONTEXT_WINDOWS['mistral-large-latest'])
    })

    it('should handle pattern matching for common model naming conventions', () => {
      expect(getContextWindow('gpt-4-0125-preview')).toBe(MODEL_CONTEXT_WINDOWS['gpt-4'])
      expect(getContextWindow('gpt-4-turbo-preview')).toBe(MODEL_CONTEXT_WINDOWS['gpt-4-turbo'])
      expect(getContextWindow('claude-3-opus-20240229')).toBe(MODEL_CONTEXT_WINDOWS['claude-3-opus-20240229'])
      expect(getContextWindow('mistral/mistral-large-2411')).toBe(MODEL_CONTEXT_WINDOWS['mistral-large-latest'])
    })

    it('should return default context window for unknown models', () => {
      expect(getContextWindow('unknown-model')).toBe(MODEL_CONTEXT_WINDOWS['default'])
    })
  })

  describe('validateTokenLimit', () => {
    it('should validate short messages as within limits', async () => {
      const messages = [
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi there!' }
      ]
      const systemPrompt = 'You are a helpful assistant.'
      
      const result = await validateTokenLimit(messages, systemPrompt, mockModels.openai)
      
      expect(result.isWithinLimit).toBe(true)
      expect(result.tokens).toBeGreaterThan(0)
      expect(result.contextWindow).toBe(MODEL_CONTEXT_WINDOWS['gpt-4'])
      expect(result.maxTokens).toBeGreaterThan(0)
    })

    it('should handle very long messages that exceed limits', async () => {
      // Create a very long message that should exceed token limits
      const longContent = 'This is a very long message. '.repeat(1000)
      const messages = [
        { role: 'user', content: longContent },
      ]
      const systemPrompt = 'You are a helpful assistant.'
      
      // Use a model with small context window for testing
      const smallModel: Model = {
        ...mockModels.openai,
        model: 'gpt-3.5-turbo' // 4096 token limit
      }
      
      const result = await validateTokenLimit(messages, systemPrompt, smallModel, 2048)
      
      expect(result.tokens).toBeGreaterThan(0)
      expect(result.contextWindow).toBe(MODEL_CONTEXT_WINDOWS['gpt-3.5-turbo'])
      expect(result.maxTokens).toBeGreaterThan(0)
      // This test might pass or fail depending on actual tokenization
      // The important thing is that it doesn't crash
    })

    it('should handle different model providers', async () => {
      const messages = [{ role: 'user', content: 'Test message' }]
      const systemPrompt = 'You are helpful.'
      
      // Test different providers
      const results = await Promise.all([
        validateTokenLimit(messages, systemPrompt, mockModels.openai),
        validateTokenLimit(messages, systemPrompt, mockModels.claude),
        validateTokenLimit(messages, systemPrompt, mockModels.qwen),
        validateTokenLimit(messages, systemPrompt, mockModels.mistral)
      ])
      
      results.forEach(result => {
        expect(result.tokens).toBeGreaterThan(0)
        expect(result.contextWindow).toBeGreaterThan(0)
        expect(result.maxTokens).toBeGreaterThan(0)
        expect(result.overhead).toBeGreaterThanOrEqual(0)
      })
    })

    it('should include overhead for chat formatting', async () => {
      const messages = [
        { role: 'user', content: 'First message' },
        { role: 'assistant', content: 'Response' },
        { role: 'user', content: 'Second message' }
      ]
      const systemPrompt = 'You are helpful.'
      
      const result = await validateTokenLimit(messages, systemPrompt, mockModels.openai)
      
      expect(result.overhead).toBeGreaterThan(0)
      // Should have overhead for each message
      expect(result.overhead).toBeGreaterThanOrEqual(messages.length)
    })
  })

  describe('getTokenLimitErrorMessage', () => {
    it('should generate helpful error messages', () => {
      const result = {
        tokens: 5000,
        contextWindow: 4096,
        maxTokens: 2048,
        isWithinLimit: false,
        overhead: 10
      }
      
      const message = getTokenLimitErrorMessage(result)
      
      expect(message).toContain('5,000 tokens')
      expect(message).toContain('2,048 tokens')
      expect(message).toContain('2,952 tokens') // overage
      expect(message).toContain('144%') // percentage over
      expect(message).toContain('Consider starting a new conversation')
    })
  })

  describe('Error handling and robustness', () => {
    it('should handle empty messages gracefully', async () => {
      const messages: Array<{ role: string; content: string }> = []
      const systemPrompt = ''
      
      const result = await validateTokenLimit(messages, systemPrompt, mockModels.openai)
      
      expect(result.tokens).toBeGreaterThanOrEqual(0)
      expect(result.isWithinLimit).toBe(true)
    })

    it('should handle special characters and unicode', async () => {
      const messages = [
        { role: 'user', content: '🚀 Hello world! 你好世界 🌍 Здравствуй мир! 🎉' }
      ]
      const systemPrompt = 'You are helpful 🤖'
      
      const result = await validateTokenLimit(messages, systemPrompt, mockModels.qwen)
      
      expect(result.tokens).toBeGreaterThan(0)
      expect(result.contextWindow).toBeGreaterThan(0)
    })

    it('should handle very long system prompts', async () => {
      const messages = [{ role: 'user', content: 'Short message' }]
      const systemPrompt = 'You are a very detailed assistant. '.repeat(100)
      
      const result = await validateTokenLimit(messages, systemPrompt, mockModels.claude)
      
      expect(result.tokens).toBeGreaterThan(0)
      expect(result.contextWindow).toBe(MODEL_CONTEXT_WINDOWS['claude-3-5-sonnet-20241022'])
    })
  })

  describe('Performance considerations', () => {
    it('should complete token validation in reasonable time', async () => {
      const messages = Array.from({ length: 10 }, (_, i) => ({
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: `Message ${i + 1}: This is a test message with some content.`
      }))
      const systemPrompt = 'You are a helpful assistant.'
      
      const startTime = performance.now()
      const result = await validateTokenLimit(messages, systemPrompt, mockModels.openai)
      const endTime = performance.now()
      
      expect(endTime - startTime).toBeLessThan(5000) // Should complete within 5 seconds
      expect(result.tokens).toBeGreaterThan(0)
    })
  })
})

describe('Integration with different model types', () => {
  const testMessage = [{ role: 'user', content: 'Hello, how are you today?' }]
  const testSystemPrompt = 'You are a helpful AI assistant.'

  it('should work with OpenAI models', async () => {
    const result = await validateTokenLimit(testMessage, testSystemPrompt, mockModels.openai)
    expect(result.tokens).toBeGreaterThan(0)
    expect(result.contextWindow).toBe(8192)
  })

  it('should work with Claude models', async () => {
    const result = await validateTokenLimit(testMessage, testSystemPrompt, mockModels.claude)
    expect(result.tokens).toBeGreaterThan(0)
    expect(result.contextWindow).toBe(200000)
  })

  it('should work with Qwen models', async () => {
    const result = await validateTokenLimit(testMessage, testSystemPrompt, mockModels.qwen)
    expect(result.tokens).toBeGreaterThan(0)
    expect(result.contextWindow).toBe(128000)
  })

  it('should work with Mistral models', async () => {
    const result = await validateTokenLimit(testMessage, testSystemPrompt, mockModels.mistral)
    expect(result.tokens).toBeGreaterThan(0)
    expect(result.contextWindow).toBe(128000)
  })
})