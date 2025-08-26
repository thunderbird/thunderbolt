import { createPrompt } from '@/ai/prompt'
import { getSetting } from '@/lib/dal'
import type { Model, ThunderboltUIMessage } from '@/types'
// tiktoken lite JSON encoders (works in Vite without WASM init)
import { Tiktoken } from '@dqbd/tiktoken/lite'
// @ts-ignore - JSON encoder files don't ship types
import cl100k_base from '@dqbd/tiktoken/encoders/cl100k_base.json' assert { type: 'json' }
// @ts-ignore - JSON encoder files don't ship types
import o200k_base from '@dqbd/tiktoken/encoders/o200k_base.json' assert { type: 'json' }

type CountTokensInput = {
  model: Model
  messages: ThunderboltUIMessage[]
  pendingUserText?: string
  reserveForResponse?: number
}

export type CountTokensResult = {
  totalPromptTokens: number
  maxContextTokens: number
  maxAllowedPromptTokens: number
  willExceedLimit: boolean
}

// Cache encoders to avoid re-creating them
let cl100kEncoder: Tiktoken | null = null
let o200kEncoder: Tiktoken | null = null

const getCl100k = () => {
  if (!cl100kEncoder) {
    cl100kEncoder = new Tiktoken(cl100k_base.bpe_ranks, cl100k_base.special_tokens, cl100k_base.pat_str)
  }
  return cl100kEncoder
}

const getO200k = () => {
  if (!o200kEncoder) {
    o200kEncoder = new Tiktoken(o200k_base.bpe_ranks, o200k_base.special_tokens, o200k_base.pat_str)
  }
  return o200kEncoder
}

const pickOpenAIEncoding = (modelName: string): 'cl100k' | 'o200k' => {
  const name = modelName.toLowerCase()
  if (name.includes('gpt-4o') || name.includes('gpt-5') || name.includes('o1') || name.includes('o3') || name.includes('o200k')) {
    return 'o200k'
  }
  return 'cl100k'
}

type ModelFamily = 'openai' | 'anthropic' | 'qwen' | 'mistral' | 'unknown'

const getModelFamily = (model: Model): ModelFamily => {
  const m = model.model.toLowerCase()
  if (model.provider === 'openai' || m.includes('gpt')) return 'openai'
  if (m.includes('claude')) return 'anthropic'
  if (m.includes('qwen')) return 'qwen'
  if (m.includes('mistral') || m.includes('nemo')) return 'mistral'
  return 'unknown'
}

// Lightweight cache for HF tokenizers
const hfTokenizerCache = new Map<string, any>()

// Map our detected families to stable HF tokenizer IDs (tokenizer is generally shared within family)
const HF_TOKENIZER_BY_FAMILY: Record<ModelFamily, string | undefined> = {
  openai: undefined,
  anthropic: undefined,
  // Qwen3 uses Qwen tokenizer; fallback to Qwen2.5 tokenizer which matches vocabulary across family
  qwen: 'Qwen/Qwen2.5-7B-Instruct',
  // Mistral family share SentencePiece tokenizer; use a widely available tokenizer
  mistral: 'mistralai/Mistral-7B-Instruct-v0.2',
  unknown: undefined,
}

const getHfTokenizer = async (family: ModelFamily) => {
  const modelId = HF_TOKENIZER_BY_FAMILY[family]
  if (!modelId) return null
  if (hfTokenizerCache.has(modelId)) return hfTokenizerCache.get(modelId)
  try {
    const { AutoTokenizer }: any = await import('@xenova/transformers')
    const tok = await AutoTokenizer.from_pretrained(modelId)
    hfTokenizerCache.set(modelId, tok)
    return tok
  } catch (e) {
    console.warn('Failed to load HF tokenizer for', family, modelId, e)
    return null
  }
}

// Conservative model context map (can be extended via settings in future)
const DEFAULT_CONTEXT_TOKENS = 128_000
const MODEL_CONTEXT_MAP: Record<string, number> = {
  // OpenAI
  'gpt-4o': 200_000,
  'gpt-4o-mini': 200_000,
  'gpt-5': 200_000,
  // Anthropic
  'claude-4-opus': 200_000,
  'claude-4-sonnet': 200_000,
  // Mistral
  'mistral-large': 128_000,
  'mistral-nemo': 128_000,
  // Qwen3 (varies by host; use 128k unless provider states otherwise)
  qwen3: 128_000,
}

const resolveContextTokens = (modelId: string, provider: string): number => {
  const key = modelId.toLowerCase()
  // Exact keys first
  for (const [k, v] of Object.entries(MODEL_CONTEXT_MAP)) {
    if (key.includes(k)) return v
  }
  // Provider-based conservative defaults
  if (provider === 'openai') return 200_000
  if (provider === 'openrouter' || provider === 'thunderbolt') return 128_000
  return DEFAULT_CONTEXT_TOKENS
}

// Render system + chat messages into a single string for tokenization
const renderForCounting = (systemPrompt: string, messages: ThunderboltUIMessage[], pendingUserText?: string): string => {
  const lines: string[] = []
  if (systemPrompt) {
    lines.push('system:\n')
    lines.push(systemPrompt)
    lines.push('\n')
  }
  for (const msg of messages) {
    const role = msg.role
    // Only count textual parts; tool calls/reasoning are accounted via safety buffer
    const textParts = (msg.parts || [])
      .filter((p: any) => p && p.type === 'text' && typeof p.text === 'string')
      .map((p: any) => p.text)
    if (textParts.length === 0) continue
    lines.push(`${role}:\n`)
    lines.push(textParts.join('\n'))
    lines.push('\n')
  }
  if (pendingUserText?.trim()) {
    lines.push('user:\n')
    lines.push(pendingUserText.trim())
    lines.push('\n')
  }
  return lines.join('')
}

// Lightweight overhead model for chat formatting and hidden provider tokens
const estimateChatOverhead = (messageCount: number): number => {
  // ~3 tokens per message + priming (~3)
  return messageCount * 3 + 3
}

// Safety cushion to cover tool-call JSON args, hidden system hints, and drift
const TOKEN_CUSHION = 512

export const countTokensForSend = async ({ model, messages, pendingUserText, reserveForResponse = 1024 }: CountTokensInput): Promise<CountTokensResult> => {
  // Build system prompt exactly like the backend
  const preferredName = (await getSetting<string>('preferred_name')) || ''
  const locationName = (await getSetting<string>('location_name')) || ''
  const locationLat = await getSetting<string>('location_lat')
  const locationLng = await getSetting<string>('location_lng')

  const systemPrompt = createPrompt({
    preferredName,
    location: {
      name: locationName || undefined,
      lat: locationLat ? parseFloat(locationLat) : undefined,
      lng: locationLng ? parseFloat(locationLng) : undefined,
    },
  })

  const serialized = renderForCounting(systemPrompt, messages, pendingUserText)

  // Choose encoding strategy based on model family
  const family = getModelFamily(model)
  let coreTokens = 0
  if (family === 'openai') {
    const encodingKind = pickOpenAIEncoding(model.model)
    const encoder = encodingKind === 'o200k' ? getO200k() : getCl100k()
    coreTokens = encoder.encode(serialized).length
  } else if (family === 'anthropic') {
    try {
      // Lazy load official Anthropic tokenizer
      const mod: any = await import('@anthropic-ai/tokenizer')
      if (typeof mod.countTokens === 'function') {
        coreTokens = mod.countTokens(serialized)
      } else if (mod?.default && typeof mod.default === 'function') {
        coreTokens = mod.default(serialized)
      } else {
        // Fallback to OpenAI encoding if API not found
        coreTokens = getCl100k().encode(serialized).length
      }
    } catch {
      coreTokens = getCl100k().encode(serialized).length
    }
  } else if (family === 'qwen' || family === 'mistral') {
    const tok = await getHfTokenizer(family)
    if (tok && typeof tok.encode === 'function') {
      try {
        const ids = tok.encode(serialized)
        coreTokens = Array.isArray(ids) ? ids.length : (ids?.input_ids?.length ?? 0)
      } catch (e) {
        console.warn('HF tokenizer encode failed; falling back to cl100k', e)
        coreTokens = getCl100k().encode(serialized).length
      }
    } else {
      // Fallback to cl100k which generally overestimates
      coreTokens = getCl100k().encode(serialized).length
    }
  } else {
    coreTokens = getCl100k().encode(serialized).length
  }
  const overhead = estimateChatOverhead(messages.length + (pendingUserText?.trim() ? 1 : 0))
  const totalPromptTokens = coreTokens + overhead + TOKEN_CUSHION

  const maxContextTokens = resolveContextTokens(model.model, model.provider)
  const maxAllowedPromptTokens = Math.max(0, maxContextTokens - reserveForResponse)

  return {
    totalPromptTokens,
    maxContextTokens,
    maxAllowedPromptTokens,
    willExceedLimit: totalPromptTokens > maxAllowedPromptTokens,
  }
}

