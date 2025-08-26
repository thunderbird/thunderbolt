import { encodingForModel } from 'js-tiktoken'
import { AutoTokenizer } from '@xenova/transformers'

// Model context window sizes (in tokens)
export const MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  // OpenAI models
  'gpt-4o': 128000,
  'gpt-4o-mini': 128000,
  'gpt-4-turbo': 128000,
  'gpt-4': 8192,
  'gpt-3.5-turbo': 4096,
  'gpt-3.5-turbo-16k': 16384,
  
  // Anthropic models
  'claude-3-5-sonnet-20241022': 200000,
  'claude-3-5-haiku-20241022': 200000,
  'claude-3-opus-20240229': 200000,
  'claude-3-sonnet-20240229': 200000,
  'claude-3-haiku-20240307': 200000,
  'claude-2.1': 200000,
  'claude-2.0': 100000,
  'claude-instant-1.2': 100000,
  
  // Mistral models
  'mistral-large-latest': 32768,
  'mistral-medium-latest': 32768,
  'mistral-small-latest': 32768,
  'nemo': 32768,
  
  // Qwen models
  'qwen2.5-72b-instruct': 32768,
  'qwen2.5-32b-instruct': 32768,
  'qwen2.5-14b-instruct': 32768,
  'qwen2.5-7b-instruct': 32768,
  'qwen2.5-3b-instruct': 32768,
  'qwen2.5-1.5b-instruct': 32768,
  'qwen2.5-0.5b-instruct': 32768,
  'qwen2.5-72b-chat': 32768,
  'qwen2.5-32b-chat': 32768,
  'qwen2.5-14b-chat': 32768,
  'qwen2.5-7b-chat': 32768,
  'qwen2.5-3b-chat': 32768,
  'qwen2.5-1.5b-chat': 32768,
  'qwen2.5-0.5b-chat': 32768,
  'qwen2.5-72b': 32768,
  'qwen2.5-32b': 32768,
  'qwen2.5-14b': 32768,
  'qwen2.5-7b': 32768,
  'qwen2.5-3b': 32768,
  'qwen2.5-1.5b': 32768,
  'qwen2.5-0.5b': 32768,
  'qwen2.5-72b-code': 32768,
  'qwen2.5-32b-code': 32768,
  'qwen2.5-14b-code': 32768,
  'qwen2.5-7b-code': 32768,
  'qwen2.5-3b-code': 32768,
  'qwen2.5-1.5b-code': 32768,
  'qwen2.5-0.5b-code': 32768,
  'qwen2.5-72b-math': 32768,
  'qwen2.5-32b-math': 32768,
  'qwen2.5-14b-math': 32768,
  'qwen2.5-7b-math': 32768,
  'qwen2.5-3b-math': 32768,
  'qwen2.5-1.5b-math': 32768,
  'qwen2.5-0.5b-math': 32768,
  'qwen2.5-72b-vl': 32768,
  'qwen2.5-32b-vl': 32768,
  'qwen2.5-14b-vl': 32768,
  'qwen2.5-7b-vl': 32768,
  'qwen2.5-3b-vl': 32768,
  'qwen2.5-1.5b-vl': 32768,
  'qwen2.5-0.5b-vl': 32768,
  'qwen2.5-72b-vl-chat': 32768,
  'qwen2.5-32b-vl-chat': 32768,
  'qwen2.5-14b-vl-chat': 32768,
  'qwen2.5-7b-vl-chat': 32768,
  'qwen2.5-3b-vl-chat': 32768,
  'qwen2.5-1.5b-vl-chat': 32768,
  'qwen2.5-0.5b-vl-chat': 32768,
  
  // Default fallback
  'default': 8192,
}

// Tokenizer cache to avoid reloading
const tokenizerCache = new Map<string, unknown>()

// Get context window size for a model
export function getModelContextWindow(modelName: string): number {
  return MODEL_CONTEXT_WINDOWS[modelName] || MODEL_CONTEXT_WINDOWS['default']
}

// Determine if a model uses OpenAI-compatible tokenization
function isOpenAIModel(modelName: string): boolean {
  return modelName.startsWith('gpt-') || 
         modelName.startsWith('claude-') ||
         modelName.includes('openai') ||
         modelName.includes('anthropic')
}

// Get the appropriate tokenizer for a model
async function getTokenizer(modelName: string) {
  const cacheKey = modelName
  
  if (tokenizerCache.has(cacheKey)) {
    return tokenizerCache.get(cacheKey)
  }

  let tokenizer: unknown

  if (isOpenAIModel(modelName)) {
    // Use js-tiktoken for OpenAI and Anthropic models
    try {
      // Try to use the model name directly, fallback to gpt-4 if it fails
      tokenizer = encodingForModel(modelName as any)
    } catch (error) {
      console.warn(`Failed to load tiktoken for ${modelName}, falling back to gpt-4:`, error)
      tokenizer = encodingForModel('gpt-4')
    }
  } else {
    // Use Hugging Face tokenizers for other models (Qwen, Mistral, etc.)
    try {
      // Map model names to HF tokenizer names
      let hfModelName = modelName
      
      if (modelName.startsWith('qwen')) {
        // Qwen models use their own tokenizer
        hfModelName = 'Qwen/Qwen2.5-7B-Instruct' // fallback to a common Qwen model
      } else if (modelName.startsWith('mistral')) {
        hfModelName = 'mistralai/Mistral-7B-Instruct-v0.2'
      }
      
      tokenizer = await AutoTokenizer.from_pretrained(hfModelName)
    } catch (error) {
      console.warn(`Failed to load HF tokenizer for ${modelName}, falling back to GPT-4:`, error)
      // Fallback to OpenAI tokenizer
      tokenizer = encodingForModel('gpt-4')
    }
  }

  tokenizerCache.set(cacheKey, tokenizer)
  return tokenizer
}

// Count tokens in text
export async function countTokens(text: string, modelName: string): Promise<number> {
  try {
    const tokenizer = await getTokenizer(modelName)
    
    if ((tokenizer as { encode?: (text: string) => number[] }).encode) {
      // OpenAI tiktoken style
      const tokens = (tokenizer as { encode: (text: string) => number[] }).encode(text)
      return tokens.length
    } else if ((tokenizer as { tokenize?: (text: string) => number[] }).tokenize) {
      // Hugging Face style
      const tokens = (tokenizer as { tokenize: (text: string) => number[] }).tokenize(text)
      return tokens.length
    } else {
      // Fallback: rough estimation (1 token ≈ 4 characters for English)
      return Math.ceil(text.length / 4)
    }
  } catch (error) {
    console.error('Error counting tokens:', error)
    // Fallback: rough estimation
    return Math.ceil(text.length / 4)
  }
}

// Count tokens in chat messages (including system prompt)
export async function countChatTokens(
  messages: Array<{ role: string; content: string }>,
  systemPrompt: string,
  modelName: string
): Promise<number> {
  try {
    // Format messages as they would be sent to the API
    let fullPrompt = systemPrompt + '\n\n'
    
    for (const message of messages) {
      if (message.role === 'system') {
        fullPrompt += `System: ${message.content}\n\n`
      } else if (message.role === 'user') {
        fullPrompt += `User: ${message.content}\n\n`
      } else if (message.role === 'assistant') {
        fullPrompt += `Assistant: ${message.content}\n\n`
      }
    }
    
    // Add a small buffer for API overhead (typically 3-10 tokens)
    const baseTokens = await countTokens(fullPrompt, modelName)
    const overheadTokens = 10
    
    return baseTokens + overheadTokens
  } catch (error) {
    console.error('Error counting chat tokens:', error)
    // Fallback: rough estimation
    const totalText = systemPrompt + '\n\n' + messages.map(m => m.content).join('\n\n')
    return Math.ceil(totalText.length / 4) + 10
  }
}

// Check if a message would exceed the token limit
export async function wouldExceedTokenLimit(
  newMessage: string,
  existingMessages: Array<{ role: string; content: string }>,
  systemPrompt: string,
  modelName: string
): Promise<{ wouldExceed: boolean; currentTokens: number; maxTokens: number; newMessageTokens: number }> {
  const maxTokens = getModelContextWindow(modelName)
  
  // Count tokens in existing conversation
  const existingTokens = await countChatTokens(existingMessages, systemPrompt, modelName)
  
  // Count tokens in new message
  const newMessageTokens = await countTokens(newMessage, modelName)
  
  // Add new message to existing messages for total count
  const totalTokens = existingTokens + newMessageTokens
  
  return {
    wouldExceed: totalTokens > maxTokens,
    currentTokens: existingTokens,
    maxTokens,
    newMessageTokens
  }
}

// Get a user-friendly error message for token limit exceeded
export function getTokenLimitErrorMessage(
  currentTokens: number,
  maxTokens: number,
  newMessageTokens: number
): string {
  const totalTokens = currentTokens + newMessageTokens
  const percentage = Math.round((totalTokens / maxTokens) * 100)
  
  return `The conversation (including tool call data) has used ${totalTokens.toLocaleString()} tokens, which exceeds the maximum of ${maxTokens.toLocaleString()} tokens (${percentage}% of limit). Consider starting a new conversation or shortening your message.`
}