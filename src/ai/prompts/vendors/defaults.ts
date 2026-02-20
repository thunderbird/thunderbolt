import type { VendorConfig } from '../types'

/** Base config applied when no vendor-specific override exists */
export const defaultVendorConfig: VendorConfig = {
  temperature: 0.2,
  maxSteps: 20,
  maxAttempts: 2,
  nudgeThreshold: 6,
}
