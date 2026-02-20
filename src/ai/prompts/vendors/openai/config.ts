import type { PartialVendorConfig } from '../../types'

/**
 * OpenAI vendor-level config — applies to ALL openai-vendor models.
 *
 * systemMessageMode: 'developer' is required for Chat Completions API
 * (AI SDK 5 defaults createOpenAI to Responses API which our backend doesn't support).
 *
 * Model-specific tuning (temperature, maxSteps) lives in models/<model>/config.ts.
 */
export const openaiVendorConfig: PartialVendorConfig = {
  providerOptions: { systemMessageMode: 'developer' as const },
}
