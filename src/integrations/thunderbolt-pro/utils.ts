import type { ThunderboltProStatus } from './types'

const proFeatures = ['search', 'web_fetch', 'weather', 'weather_forecast']

/**
 * All users currently have Pro access — this is an intentional business decision.
 * When a paid tier is introduced, replace with a real entitlement check.
 */
export const getProStatus = async (): Promise<ThunderboltProStatus> => {
  return { isProUser: true, features: proFeatures }
}

export const hasProAccess = async (): Promise<boolean> => true
