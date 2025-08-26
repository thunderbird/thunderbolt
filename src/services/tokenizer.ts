import { encodingForModel, type TiktokenModel } from 'js-tiktoken'
import { AutoTokenizer, type PreTrainedTokenizer } from '@xenova/transformers'
import type { ThunderboltUIMessage } from '@/types'

// Model context window limits (in tokens)
// These values are based on official documentation
export const MODEL_CONTEXT_LIMITS: Record<string, number> = {
  // OpenAI models
  'gpt-3.5-turbo': 16385,
  'gpt-3.5-turbo-16k': 16385,
  'gpt-4': 8192,
  'gpt-4-32k': 32768,
  'gpt-4-turbo': 128000,
  'gpt-4o': 128000,
  'gpt-4o-mini': 128000,
  'gpt-5': 128000, // Placeholder - update when GPT-5 is released

  // Anthropic models
  'claude-3-opus-20240229': 200000,
  'claude-3-sonnet-20240229': 200000,
  'claude-3-haiku-20240307': 200000,
  'claude-3.5-sonnet-20241022': 200000,
  'claude-3.5-haiku-20241022': 200000,
  'claude-4-opus': 200000, // Placeholder - update when Claude 4 is released
  'claude-4-sonnet': 200000, // Placeholder

  // Mistral models
  'mistral-large-latest': 128000,
  'mistral-large-2411': 128000,
  'mistral-nemo': 128000,
  'open-mistral-nemo': 128000,
  'open-mistral-7b': 32768,
  'open-mixtral-8x7b': 32768,
  'open-mixtral-8x22b': 65536,

  // Qwen models
  'qwen/qwen-2.5-72b-instruct': 128000,
  'qwen/qwen-2.5-32b-instruct': 32768,
  'qwen/qwen-2.5-14b-instruct': 128000,
  'qwen/qwen-2.5-7b-instruct': 128000,
  'qwen/qwen-2.5-3b-instruct': 32768,
  'qwen/qwen-2.5-1.5b-instruct': 32768,
  'qwen/qwen-2.5-0.5b-instruct': 32768,

  // Default fallback
  default: 8192,
}

// Message role overhead tokens for OpenAI chat format
const OPENAI_MESSAGE_OVERHEAD = 4 // Approximate tokens per message for role/formatting
const OPENAI_REPLY_OVERHEAD = 3 // Tokens for assistant reply priming

interface TokenizerCache {
  tiktoken: Map<string, ReturnType<typeof encodingForModel>>
  transformers: Map<string, PreTrainedTokenizer>
}

export class TokenizerService {
  private static instance: TokenizerService | null = null
  private cache: TokenizerCache = {
    tiktoken: new Map(),
    transformers: new Map(),
  }

  private constructor() {}

  static getInstance(): TokenizerService {
    if (!TokenizerService.instance) {
      TokenizerService.instance = new TokenizerService()
    }
    return TokenizerService.instance
  }

  /**
   * Get the context window limit for a model
   */
  getContextLimit(modelId: string): number {
    // Try exact match first
    if (MODEL_CONTEXT_LIMITS[modelId]) {
      return MODEL_CONTEXT_LIMITS[modelId]
    }

    // Try to find a partial match (for custom model names that include the base model)
    const lowerModelId = modelId.toLowerCase()
    for (const [key, limit] of Object.entries(MODEL_CONTEXT_LIMITS)) {
      if (lowerModelId.includes(key.toLowerCase())) {
        return limit
      }
    }

    // Return default if no match found
    return MODEL_CONTEXT_LIMITS.default
  }

  /**
   * Count tokens for a given text using the appropriate tokenizer
   */
  async countTokens(text: string, modelId: string, provider: string): Promise<number> {
    try {
      // For OpenAI models, use tiktoken
      if (provider === 'openai' || this.isOpenAICompatibleModel(modelId)) {
        return await this.countTokensWithTiktoken(text, modelId)
      }

      // For other models, use transformers
      return await this.countTokensWithTransformers(text, modelId, provider)
    } catch (error) {
      console.warn(`Failed to count tokens for model ${modelId}, using fallback estimation`, error)
      // Fallback: rough estimation (1 token ≈ 4 characters)
      return Math.ceil(text.length / 4)
    }
  }

  /**
   * Count tokens for chat messages, including formatting overhead
   */
  async countChatTokens(
    messages: ThunderboltUIMessage[],
    modelId: string,
    provider: string,
    systemPrompt?: string,
  ): Promise<number> {
    let totalTokens = 0

    // Count system prompt if provided
    if (systemPrompt) {
      totalTokens += await this.countTokens(systemPrompt, modelId, provider)
      totalTokens += OPENAI_MESSAGE_OVERHEAD // System message overhead
    }

    // Count each message
    for (const message of messages) {
      // Get message content as string from parts
      let messageContent = ''
      if (message.parts) {
        for (const part of message.parts) {
          if (part.type === 'text') {
            messageContent += part.text || ''
          } else if (part.type.startsWith('tool')) {
            // Count tool-related tokens (tool-call, tool-result, etc.)
            // Tool parts have various structures, so we serialize the whole part
            const toolContent = JSON.stringify(part)
            totalTokens += await this.countTokens(toolContent, modelId, provider)
          }
        }
      }

      // Count the text content
      if (messageContent) {
        const messageTokens = await this.countTokens(messageContent, modelId, provider)
        totalTokens += messageTokens + OPENAI_MESSAGE_OVERHEAD
      } else {
        // Even empty messages have overhead
        totalTokens += OPENAI_MESSAGE_OVERHEAD
      }
    }

    // Add reply priming overhead
    totalTokens += OPENAI_REPLY_OVERHEAD

    return totalTokens
  }

  /**
   * Validate if messages fit within the model's context window
   */
  async validateTokenLimit(
    messages: ThunderboltUIMessage[],
    modelId: string,
    provider: string,
    systemPrompt?: string,
    maxOutputTokens: number = 2048, // Reserve tokens for response
  ): Promise<{ valid: boolean; tokenCount: number; limit: number; message?: string }> {
    const tokenCount = await this.countChatTokens(messages, modelId, provider, systemPrompt)
    const contextLimit = this.getContextLimit(modelId)
    const effectiveLimit = contextLimit - maxOutputTokens

    if (tokenCount > effectiveLimit) {
      return {
        valid: false,
        tokenCount,
        limit: contextLimit,
        message: `The conversation (including tool call data) has exceeded the maximum token limit (${tokenCount.toLocaleString()} / ${effectiveLimit.toLocaleString()} tokens). Consider starting a new conversation or shortening your message.`,
      }
    }

    return {
      valid: true,
      tokenCount,
      limit: contextLimit,
    }
  }

  private isOpenAICompatibleModel(modelId: string): boolean {
    const openAIModels = ['gpt-3', 'gpt-4', 'text-davinci', 'text-curie', 'text-babbage', 'text-ada']
    return openAIModels.some((prefix) => modelId.toLowerCase().startsWith(prefix))
  }

  private async countTokensWithTiktoken(text: string, modelId: string): Promise<number> {
    try {
      // Get or create encoder
      let encoder = this.cache.tiktoken.get(modelId)
      if (!encoder) {
        // Map model ID to tiktoken model name
        const tiktokenModel = this.mapToTiktokenModel(modelId)
        encoder = encodingForModel(tiktokenModel)
        this.cache.tiktoken.set(modelId, encoder)
      }

      // Encode and count tokens
      const tokens = encoder.encode(text)
      return tokens.length
    } catch (error) {
      console.warn(`Tiktoken encoding failed for model ${modelId}`, error)
      // Try with default GPT-4 encoder
      const defaultEncoder = encodingForModel('gpt-4')
      const tokens = defaultEncoder.encode(text)
      return tokens.length
    }
  }

  private async countTokensWithTransformers(text: string, modelId: string, provider: string): Promise<number> {
    try {
      // Map to Hugging Face model ID
      const hfModelId = this.mapToHuggingFaceModel(modelId, provider)

      // Get or create tokenizer
      let tokenizer = this.cache.transformers.get(hfModelId)
      if (!tokenizer) {
        tokenizer = await AutoTokenizer.from_pretrained(hfModelId)
        this.cache.transformers.set(hfModelId, tokenizer)
      }

      // Encode and count tokens
      const encoded = tokenizer.encode(text)
      return encoded.length
    } catch (error) {
      console.warn(`Transformers tokenization failed for model ${modelId}`, error)
      throw error
    }
  }

  private mapToTiktokenModel(modelId: string): TiktokenModel {
    const lowerModelId = modelId.toLowerCase()

    // GPT-4o models
    if (lowerModelId.includes('gpt-4o')) {
      return 'gpt-4o'
    }

    // GPT-4 models
    if (lowerModelId.includes('gpt-4-turbo') || lowerModelId.includes('gpt-4-1106')) {
      return 'gpt-4-turbo'
    }
    if (lowerModelId.includes('gpt-4-32k')) {
      return 'gpt-4-32k'
    }
    if (lowerModelId.includes('gpt-4')) {
      return 'gpt-4'
    }

    // GPT-3.5 models
    if (lowerModelId.includes('gpt-3.5-turbo-16k')) {
      return 'gpt-3.5-turbo-16k'
    }
    if (lowerModelId.includes('gpt-3.5')) {
      return 'gpt-3.5-turbo'
    }

    // Default to GPT-4 for unknown models
    return 'gpt-4'
  }

  private mapToHuggingFaceModel(modelId: string, _provider: string): string {
    // Map common model IDs to their Hugging Face equivalents
    const mappings: Record<string, string> = {
      // Anthropic Claude models - use GPT-4 tokenizer as approximation
      'claude-3-opus-20240229': 'Xenova/gpt-4o',
      'claude-3-sonnet-20240229': 'Xenova/gpt-4o',
      'claude-3-haiku-20240307': 'Xenova/gpt-4o',
      'claude-3.5-sonnet-20241022': 'Xenova/gpt-4o',
      'claude-3.5-haiku-20241022': 'Xenova/gpt-4o',
      'claude-4-opus': 'Xenova/gpt-4o',
      'claude-4-sonnet': 'Xenova/gpt-4o',

      // Mistral models
      'mistral-large-latest': 'Xenova/mistral-tokenizer-v3',
      'mistral-large-2411': 'Xenova/mistral-tokenizer-v3',
      'mistral-nemo': 'Xenova/mistral-tokenizer-v3',
      'open-mistral-nemo': 'Xenova/mistral-tokenizer-v3',
      'open-mistral-7b': 'Xenova/mistral-tokenizer-v1',
      'open-mixtral-8x7b': 'Xenova/mistral-tokenizer-v1',
      'open-mixtral-8x22b': 'Xenova/mistral-tokenizer-v3',

      // Qwen models
      'qwen/qwen-2.5-72b-instruct': 'Xenova/Qwen2.5-Tokenizer',
      'qwen/qwen-2.5-32b-instruct': 'Xenova/Qwen2.5-Tokenizer',
      'qwen/qwen-2.5-14b-instruct': 'Xenova/Qwen2.5-Tokenizer',
      'qwen/qwen-2.5-7b-instruct': 'Xenova/Qwen2.5-Tokenizer',
      'qwen/qwen-2.5-3b-instruct': 'Xenova/Qwen2.5-Tokenizer',
      'qwen/qwen-2.5-1.5b-instruct': 'Xenova/Qwen2.5-Tokenizer',
      'qwen/qwen-2.5-0.5b-instruct': 'Xenova/Qwen2.5-Tokenizer',
    }

    // Check if we have a direct mapping
    if (mappings[modelId]) {
      return mappings[modelId]
    }

    // Try to infer from model ID
    const lowerModelId = modelId.toLowerCase()

    if (lowerModelId.includes('qwen')) {
      return 'Xenova/Qwen2.5-Tokenizer'
    }

    if (lowerModelId.includes('mistral') || lowerModelId.includes('mixtral')) {
      return 'Xenova/mistral-tokenizer-v3'
    }

    if (lowerModelId.includes('llama')) {
      return 'Xenova/llama-tokenizer'
    }

    // Default to GPT-4 tokenizer for unknown models
    return 'Xenova/gpt-4o'
  }
}

// Export singleton instance
export const tokenizerService = TokenizerService.getInstance()
