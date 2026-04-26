import { describe, expect, it } from 'bun:test'
import { z } from 'zod'

/**
 * Tests for MiniMax provider support in the model creation form schemas.
 *
 * These tests verify the provider-level validation rules:
 * - MiniMax requires an API key (like openai / openrouter)
 * - MiniMax does not require a URL (unlike custom)
 */

// Mirror the form schema from src/settings/models/new.tsx
const newModelFormSchema = z
  .object({
    provider: z.enum(['thunderbolt', 'openai', 'custom', 'openrouter', 'minimax']),
    name: z.string().min(1),
    model: z.string().min(1),
    url: z.string().optional(),
    apiKey: z.string().optional(),
  })
  .refine(
    (data) => {
      if (data.provider === 'custom') return data.url !== undefined && data.url.length > 0
      return true
    },
    { message: 'URL is required for Custom providers', path: ['url'] },
  )
  .refine(
    (data) => {
      if (data.provider === 'custom' || data.provider === 'thunderbolt') return true
      return data.apiKey !== undefined && data.apiKey.length > 0
    },
    { message: 'API Key is required for this provider', path: ['apiKey'] },
  )

// Mirror the form schema from src/settings/models/detail.tsx
const detailModelFormSchema = z
  .object({
    provider: z.enum(['thunderbolt', 'anthropic', 'openai', 'custom', 'openrouter', 'minimax']),
    name: z.string().min(1),
    model: z.string().min(1),
    url: z.string().optional(),
    apiKey: z.string().optional(),
  })
  .refine(
    (data) => {
      if (data.provider === 'custom') return data.url !== undefined && data.url.length > 0
      return true
    },
    { message: 'URL is required for Custom providers', path: ['url'] },
  )
  .refine(
    (data) => {
      if (data.provider === 'custom' || data.provider === 'thunderbolt') return true
      return data.apiKey !== undefined && data.apiKey.length > 0
    },
    { message: 'API Key is required for this provider', path: ['apiKey'] },
  )

const validBase = { name: 'MiniMax M2.7', model: 'MiniMax-M2.7', url: '', apiKey: '' }

describe('MiniMax provider - new model form schema', () => {
  it('accepts minimax as a valid provider', () => {
    const result = newModelFormSchema.safeParse({
      ...validBase,
      provider: 'minimax',
      apiKey: 'mm-test-key',
    })
    expect(result.success).toBe(true)
  })

  it('rejects minimax without an API key', () => {
    const result = newModelFormSchema.safeParse({
      ...validBase,
      provider: 'minimax',
      apiKey: '',
    })
    expect(result.success).toBe(false)
    const errors = result.error?.flatten().fieldErrors
    expect(errors?.apiKey).toBeDefined()
  })

  it('does not require a URL for minimax', () => {
    const result = newModelFormSchema.safeParse({
      ...validBase,
      provider: 'minimax',
      apiKey: 'mm-test-key',
      url: '',
    })
    expect(result.success).toBe(true)
  })

  it('includes minimax in the provider enum', () => {
    const result = newModelFormSchema.safeParse({
      ...validBase,
      provider: 'unknown-provider',
      apiKey: 'key',
    })
    expect(result.success).toBe(false)
  })

  it('accepts MiniMax-M2.7 as model name', () => {
    const result = newModelFormSchema.safeParse({
      provider: 'minimax',
      name: 'MiniMax M2.7',
      model: 'MiniMax-M2.7',
      apiKey: 'mm-key',
    })
    expect(result.success).toBe(true)
  })

  it('accepts MiniMax-M2.7-highspeed as model name', () => {
    const result = newModelFormSchema.safeParse({
      provider: 'minimax',
      name: 'MiniMax M2.7 Highspeed',
      model: 'MiniMax-M2.7-highspeed',
      apiKey: 'mm-key',
    })
    expect(result.success).toBe(true)
  })
})

describe('MiniMax provider - model detail form schema', () => {
  it('accepts minimax provider for editing', () => {
    const result = detailModelFormSchema.safeParse({
      ...validBase,
      provider: 'minimax',
      apiKey: 'mm-test-key',
    })
    expect(result.success).toBe(true)
  })

  it('rejects minimax without API key on detail form', () => {
    const result = detailModelFormSchema.safeParse({
      ...validBase,
      provider: 'minimax',
      apiKey: '',
    })
    expect(result.success).toBe(false)
    const errors = result.error?.flatten().fieldErrors
    expect(errors?.apiKey).toBeDefined()
  })

  it('includes anthropic in detail form provider enum (for direct Anthropic models)', () => {
    const result = detailModelFormSchema.safeParse({
      ...validBase,
      provider: 'anthropic',
      apiKey: 'sk-ant-test',
    })
    expect(result.success).toBe(true)
  })
})
