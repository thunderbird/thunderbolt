import { encodingForModel, Tiktoken } from 'js-tiktoken'
import { AutoTokenizer } from '@xenova/transformers'
import { Model } from '@/types'

// Context window sizes for various models (in tokens)
export const MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  // OpenAI models
  'gpt-4': 8192,
  'gpt-4-32k': 32768,
  'gpt-4-turbo': 128000,
  'gpt-4o': 128000,
  'gpt-4o-mini': 128000,
  'gpt-5': 200000, // Estimated based on reports
  'gpt-3.5-turbo': 4096,
  'gpt-3.5-turbo-16k': 16384,
  
  // Anthropic Claude models
  'claude-3-sonnet-20240229': 200000,
  'claude-3-opus-20240229': 200000,
  'claude-3-haiku-20240307': 200000,
  'claude-3-5-sonnet-20241022': 200000,
  'claude-4-sonnet': 200000, // Estimated
  'claude-4-opus': 200000, // Estimated
  
  // Qwen models
  'qwen-turbo': 8192,
  'qwen-plus': 32768,
  'qwen-max': 128000,
  'qwen2.5-72b-instruct': 128000,
  'qwen2.5-coder-32b-instruct': 128000,
  'qwen/qwen-2.5-72b-instruct': 128000,
  'qwen/qwen-2.5-coder-32b-instruct': 128000,
  'qwen3-14b': 128000,
  'qwen3-32b': 32768,
  
  // Mistral models
  'mistral-large-latest': 128000,
  'mistral-large-2411': 128000,
  'mistral-large-2407': 128000,
  'mistral-nemo': 128000,
  'mistral/mistral-large-2411': 128000,
  'mistral/mistral-nemo': 128000,
  
  // Default fallback
  'default': 8192,
}

// Chat message overhead tokens (approximate)
export const CHAT_MESSAGE_OVERHEAD = {
  openai: 4, // ~3-4 tokens per message for OpenAI format
  anthropic: 5, // ~5 tokens per message for Claude format
  default: 3, // Conservative default
}

// Safety margin (percentage of context window to reserve)
export const SAFETY_MARGIN_PERCENTAGE = 0.05 // 5%
export const MIN_SAFETY_MARGIN = 256 // Minimum tokens to reserve

interface TokenCountResult {
  tokens: number
  contextWindow: number
  maxTokens: number
  isWithinLimit: boolean
  overhead: number
}

interface TokenizerCache {
  tiktoken?: { [encoding: string]: Tiktoken }
  transformers?: { [model: string]: any }
}

// Global cache for tokenizers to avoid repeated loading
const tokenizerCache: TokenizerCache = {
  tiktoken: {},
  transformers: {},
}

/**
 * Get the context window size for a model
 */
export function getContextWindow(modelName: string): number {
  // Try exact match first
  if (MODEL_CONTEXT_WINDOWS[modelName]) {
    return MODEL_CONTEXT_WINDOWS[modelName]
  }
  
  // Try pattern matching for common model naming conventions
  const lowerModel = modelName.toLowerCase()
  
  // OpenAI patterns
  if (lowerModel.includes('gpt-4o')) return MODEL_CONTEXT_WINDOWS['gpt-4o']
  if (lowerModel.includes('gpt-4-turbo')) return MODEL_CONTEXT_WINDOWS['gpt-4-turbo']
  if (lowerModel.includes('gpt-4') && lowerModel.includes('32k')) return MODEL_CONTEXT_WINDOWS['gpt-4-32k']
  if (lowerModel.includes('gpt-4')) return MODEL_CONTEXT_WINDOWS['gpt-4']
  if (lowerModel.includes('gpt-5')) return MODEL_CONTEXT_WINDOWS['gpt-5']
  if (lowerModel.includes('gpt-3.5') && lowerModel.includes('16k')) return MODEL_CONTEXT_WINDOWS['gpt-3.5-turbo-16k']
  if (lowerModel.includes('gpt-3.5')) return MODEL_CONTEXT_WINDOWS['gpt-3.5-turbo']
  
  // Claude patterns
  if (lowerModel.includes('claude-4')) return MODEL_CONTEXT_WINDOWS['claude-4-sonnet']
  if (lowerModel.includes('claude-3')) return MODEL_CONTEXT_WINDOWS['claude-3-sonnet-20240229']
  if (lowerModel.includes('claude')) return MODEL_CONTEXT_WINDOWS['claude-3-sonnet-20240229']
  
  // Qwen patterns
  if (lowerModel.includes('qwen') && lowerModel.includes('72b')) return MODEL_CONTEXT_WINDOWS['qwen2.5-72b-instruct']
  if (lowerModel.includes('qwen') && lowerModel.includes('32b')) return MODEL_CONTEXT_WINDOWS['qwen2.5-coder-32b-instruct']
  if (lowerModel.includes('qwen3')) return MODEL_CONTEXT_WINDOWS['qwen3-14b']
  if (lowerModel.includes('qwen')) return MODEL_CONTEXT_WINDOWS['qwen-max']
  
  // Mistral patterns
  if (lowerModel.includes('mistral') && lowerModel.includes('large')) return MODEL_CONTEXT_WINDOWS['mistral-large-latest']
  if (lowerModel.includes('mistral') && lowerModel.includes('nemo')) return MODEL_CONTEXT_WINDOWS['mistral-nemo']
  if (lowerModel.includes('mistral')) return MODEL_CONTEXT_WINDOWS['mistral-large-latest']
  
  // Default fallback
  return MODEL_CONTEXT_WINDOWS['default']
}

/**
 * Get the appropriate tokenizer encoding for OpenAI models
 */
function getOpenAIEncoding(modelName: string): string {
  const lowerModel = modelName.toLowerCase()
  
  if (lowerModel.includes('gpt-4') || lowerModel.includes('gpt-5')) {
    return 'cl100k_base' // GPT-4 and newer models
  }
  if (lowerModel.includes('gpt-3.5')) {
    return 'cl100k_base' // GPT-3.5-turbo uses cl100k_base
  }
  
  // Default to cl100k_base for modern models
  return 'cl100k_base'
}

/**
 * Get the Hugging Face model identifier for tokenization
 */
function getHuggingFaceTokenizerModel(modelName: string, _provider: string): string {
  const lowerModel = modelName.toLowerCase()
  
  // Handle provider-specific mappings
  if (lowerModel.includes('claude')) {
    // Use a GPT-4 tokenizer as approximation for Claude
    // This is not perfect but gives a reasonable estimate
    return 'Xenova/gpt-4'
  }
  
  // Qwen models
  if (lowerModel.includes('qwen')) {
    if (lowerModel.includes('2.5')) {
      return 'Xenova/Qwen2.5-Coder-7B-Instruct'
    }
    return 'Xenova/Qwen2-7B-Instruct'
  }
  
  // Mistral models
  if (lowerModel.includes('mistral')) {
    if (lowerModel.includes('nemo')) {
      return 'Xenova/Mistral-Nemo-Instruct-2407'
    }
    return 'Xenova/Mistral-7B-Instruct-v0.3'
  }
  
  // Default to GPT-4 tokenizer for unknown models
  return 'Xenova/gpt-4'
}

/**
 * Count tokens using TikToken for OpenAI models
 */
async function countTokensWithTikToken(text: string, modelName: string): Promise<number> {
  const encoding = getOpenAIEncoding(modelName)
  
  if (!tokenizerCache.tiktoken![encoding]) {
    tokenizerCache.tiktoken![encoding] = encodingForModel(modelName as any) || encodingForModel('gpt-4')
  }
  
  const tokenizer = tokenizerCache.tiktoken![encoding]
  const tokens = tokenizer.encode(text)
  return tokens.length
}

/**
 * Count tokens using Transformers for non-OpenAI models
 */
async function countTokensWithTransformers(text: string, modelName: string, provider: string): Promise<number> {
  const huggingFaceModel = getHuggingFaceTokenizerModel(modelName, provider)
  
  if (!tokenizerCache.transformers![huggingFaceModel]) {
    try {
      tokenizerCache.transformers![huggingFaceModel] = await AutoTokenizer.from_pretrained(huggingFaceModel)
    } catch (error) {
      console.warn(`Failed to load tokenizer for ${huggingFaceModel}, falling back to GPT-4 tokenizer:`, error)
      // Fallback to GPT-4 tokenizer
      tokenizerCache.transformers![huggingFaceModel] = await AutoTokenizer.from_pretrained('Xenova/gpt-4')
    }
  }
  
  const tokenizer = tokenizerCache.transformers![huggingFaceModel]
  const tokens = tokenizer.encode(text)
  return tokens.length
}

/**
 * Apply chat template formatting and count tokens for a conversation
 */
async function countChatTokens(
  messages: Array<{ role: string; content: string }>,
  systemPrompt: string,
  model: Model
): Promise<number> {
  // Construct the full conversation text as it would be sent to the model
  let conversationText = ''
  
  // Add system prompt if provided
  if (systemPrompt.trim()) {
    conversationText += `System: ${systemPrompt}\n\n`
  }
  
  // Add conversation messages
  for (const message of messages) {
    conversationText += `${message.role}: ${message.content}\n\n`
  }
  
  // Add assistant prompt prefix (most models expect this)
  conversationText += 'Assistant: '
  
  // Count tokens based on provider
  let baseTokens: number
  
  if (model.provider === 'openai') {
    baseTokens = await countTokensWithTikToken(conversationText, model.model)
  } else {
    baseTokens = await countTokensWithTransformers(conversationText, model.model, model.provider)
  }
  
  // Add overhead for chat formatting
  const overhead = model.provider === 'openai' 
    ? CHAT_MESSAGE_OVERHEAD.openai * messages.length
    : model.model.toLowerCase().includes('claude')
    ? CHAT_MESSAGE_OVERHEAD.anthropic * messages.length
    : CHAT_MESSAGE_OVERHEAD.default * messages.length
  
  return baseTokens + overhead
}

/**
 * Validate if a conversation is within token limits
 */
export async function validateTokenLimit(
  messages: Array<{ role: string; content: string }>,
  systemPrompt: string,
  model: Model,
  maxOutputTokens: number = 4096
): Promise<TokenCountResult> {
  const contextWindow = getContextWindow(model.model)
  const totalTokens = await countChatTokens(messages, systemPrompt, model)
  
  // Calculate safety margin
  const safetyMargin = Math.max(
    Math.floor(contextWindow * SAFETY_MARGIN_PERCENTAGE),
    MIN_SAFETY_MARGIN
  )
  
  // Maximum tokens available for input (context window - max output - safety margin)
  const maxInputTokens = contextWindow - maxOutputTokens - safetyMargin
  
  const overhead = model.provider === 'openai' 
    ? CHAT_MESSAGE_OVERHEAD.openai * messages.length
    : model.model.toLowerCase().includes('claude')
    ? CHAT_MESSAGE_OVERHEAD.anthropic * messages.length
    : CHAT_MESSAGE_OVERHEAD.default * messages.length
  
  return {
    tokens: totalTokens,
    contextWindow,
    maxTokens: maxInputTokens,
    isWithinLimit: totalTokens <= maxInputTokens,
    overhead,
  }
}

/**
 * Get a user-friendly error message for token limit exceeded
 */
export function getTokenLimitErrorMessage(result: TokenCountResult): string {
  const overage = result.tokens - result.maxTokens
  const percentage = Math.round((overage / result.maxTokens) * 100)
  
  return `The conversation (including tool call data) has used ${result.tokens.toLocaleString()} tokens, which exceeds the maximum of ${result.maxTokens.toLocaleString()} tokens by ${overage.toLocaleString()} tokens (${percentage}% over limit). Consider starting a new conversation or shortening your message.`
}

/**
 * Preload tokenizers for better performance
 */
export async function preloadTokenizers(models: Model[]): Promise<void> {
  const promises: Promise<any>[] = []
  
  for (const model of models) {
    if (model.provider === 'openai') {
      // Preload TikToken encoder
      const encoding = getOpenAIEncoding(model.model)
      if (!tokenizerCache.tiktoken![encoding]) {
        promises.push(
          (async () => {
            try {
              tokenizerCache.tiktoken![encoding] = encodingForModel(model.model as any) || encodingForModel('gpt-4')
            } catch (error) {
              console.warn(`Failed to preload TikToken for ${model.model}:`, error)
            }
          })()
        )
      }
    } else {
      // Preload Transformers tokenizer
      const huggingFaceModel = getHuggingFaceTokenizerModel(model.model, model.provider)
      if (!tokenizerCache.transformers![huggingFaceModel]) {
        promises.push(
          (async () => {
            try {
              tokenizerCache.transformers![huggingFaceModel] = await AutoTokenizer.from_pretrained(huggingFaceModel)
            } catch (error) {
              console.warn(`Failed to preload tokenizer for ${huggingFaceModel}:`, error)
            }
          })()
        )
      }
    }
  }
  
  await Promise.allSettled(promises)
}