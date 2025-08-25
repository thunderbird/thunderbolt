import { getEncoding, type TikTokenEncoding } from 'gpt-tokenizer'
import type { ThunderboltUIMessage } from '@/types'

// Define token limits for different model families
export const TOKEN_LIMITS: Record<string, number> = {
  // OpenAI models
  'gpt-3.5-turbo': 4096,
  'gpt-3.5-turbo-16k': 16384,
  'gpt-4': 8192,
  'gpt-4-32k': 32768,
  'gpt-4-turbo': 128000,
  'gpt-4o': 128000,
  'gpt-4o-mini': 128000,
  'text-davinci-003': 4097,
  'text-davinci-002': 4097,
  
  // Default fallback for unknown models
  default: 4096,
}

// Map model names to appropriate tiktoken encodings
function getEncodingForModel(modelName: string): TikTokenEncoding {
  const model = modelName.toLowerCase()
  
  // GPT-4 family models
  if (model.includes('gpt-4')) {
    return 'cl100k_base'
  }
  
  // GPT-3.5 family models
  if (model.includes('gpt-3.5') || model.includes('gpt-35')) {
    return 'cl100k_base'
  }
  
  // Older GPT-3 models
  if (model.includes('davinci') || model.includes('curie') || model.includes('babbage') || model.includes('ada')) {
    return 'p50k_base'
  }
  
  // Default to cl100k_base for modern models (OpenRouter, custom models, etc.)
  return 'cl100k_base'
}

/**
 * Get the token limit for a given model
 */
export function getTokenLimitForModel(modelName: string): number {
  const model = modelName.toLowerCase()
  
  // Check for exact matches first
  for (const [key, limit] of Object.entries(TOKEN_LIMITS)) {
    if (model === key || model.includes(key)) {
      return limit
    }
  }
  
  // For newer models or unknowns, be conservative and use a reasonable default
  // Most modern models have at least 4K tokens, many have much more
  if (model.includes('gpt-4') || model.includes('claude') || model.includes('llama')) {
    return 128000 // Most modern models have large context windows
  }
  
  return TOKEN_LIMITS.default
}

/**
 * Count tokens in a single message
 */
export function countTokensInMessage(message: string, modelName: string): number {
  try {
    const encoding = getEncodingForModel(modelName)
    const encoder = getEncoding(encoding)
    const tokens = encoder.encode(message)
    encoder.free() // Free memory
    return tokens.length
  } catch (error) {
    console.warn('Failed to count tokens, using fallback estimation:', error)
    // Fallback: rough estimation of ~4 characters per token
    return Math.ceil(message.length / 4)
  }
}

/**
 * Count tokens in a conversation (array of messages)
 * This includes both the message content and the structural tokens needed for the API
 */
export function countTokensInConversation(messages: ThunderboltUIMessage[], modelName: string): number {
  let totalTokens = 0
  
  try {
    const encoding = getEncodingForModel(modelName)
    const encoder = getEncoding(encoding)
    
    for (const message of messages) {
      // Count tokens in the message content
      if (message.content) {
        const contentTokens = encoder.encode(message.content)
        totalTokens += contentTokens.length
      }
      
      // Count tokens in tool calls if present
      if (message.toolCalls) {
        for (const toolCall of message.toolCalls) {
          // Tool name
          const nameTokens = encoder.encode(toolCall.toolName)
          totalTokens += nameTokens.length
          
          // Tool arguments (JSON stringified)
          const argsString = JSON.stringify(toolCall.input)
          const argsTokens = encoder.encode(argsString)
          totalTokens += argsTokens.length
        }
      }
      
      // Add overhead tokens for message structure
      // Each message has overhead for role, formatting, etc.
      totalTokens += 4 // Approximate overhead per message
    }
    
    // Add overhead for the conversation structure
    totalTokens += 3 // Conversation-level overhead
    
    encoder.free() // Free memory
    
    return totalTokens
  } catch (error) {
    console.warn('Failed to count conversation tokens, using fallback estimation:', error)
    
    // Fallback: rough estimation
    let estimatedTokens = 0
    for (const message of messages) {
      if (message.content) {
        estimatedTokens += Math.ceil(message.content.length / 4)
      }
      if (message.toolCalls) {
        for (const toolCall of message.toolCalls) {
          const toolCallString = toolCall.toolName + JSON.stringify(toolCall.input)
          estimatedTokens += Math.ceil(toolCallString.length / 4)
        }
      }
      estimatedTokens += 4 // Message overhead
    }
    
    return estimatedTokens
  }
}

/**
 * Check if a conversation would exceed the token limit for a given model
 */
export function wouldExceedTokenLimit(
  messages: ThunderboltUIMessage[], 
  modelName: string,
  newMessage?: string
): { exceeds: boolean; tokenCount: number; limit: number; newMessageTokens?: number } {
  const currentTokens = countTokensInConversation(messages, modelName)
  const limit = getTokenLimitForModel(modelName)
  
  let newMessageTokens = 0
  if (newMessage) {
    newMessageTokens = countTokensInMessage(newMessage, modelName)
    // Add overhead for the new message structure
    newMessageTokens += 4
  }
  
  const totalTokens = currentTokens + newMessageTokens
  
  return {
    exceeds: totalTokens > limit,
    tokenCount: totalTokens,
    limit,
    newMessageTokens: newMessage ? newMessageTokens : undefined,
  }
}

/**
 * Create a user-friendly error message for token limit exceeded
 */
export function createTokenLimitErrorMessage(tokenCount: number, limit: number): string {
  const excessTokens = tokenCount - limit
  const excessPercentage = Math.round((excessTokens / limit) * 100)
  
  return `The conversation (including tool call data) has used ${tokenCount.toLocaleString()} tokens, which exceeds the maximum of ${limit.toLocaleString()} tokens by ${excessTokens.toLocaleString()} tokens (${excessPercentage}% over the limit). Consider starting a new conversation or shortening your message.`
}