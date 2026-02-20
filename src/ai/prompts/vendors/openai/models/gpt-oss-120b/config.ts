import type { PartialVendorConfig } from '../../../../types'

/**
 * GPT-OSS 120B model-specific config — tuned through E2E eval testing.
 *
 * These override the vendor-level OpenAI config:
 * - Lower maxSteps (8) to force earlier synthesis — final step nudge fires at step 7
 * - Higher maxAttempts (4) to recover from empty responses across retries
 * - Preventive nudge at step 5 — gives a gentle mid-point heads-up
 * - Temperature 0.3 — slightly higher than default for variety, but not too high
 */
export const gptOss120bConfig: PartialVendorConfig = {
  temperature: 0.3,
  maxSteps: 8,
  maxAttempts: 4,
  nudgeThreshold: 5,
}
