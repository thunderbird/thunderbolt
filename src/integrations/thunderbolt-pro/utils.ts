import type { ThunderboltProStatus } from './types'

// Hardcoded constant for testing - can be switched back and forth
const isProUser = true // Set to false to test "Get Pro" button

/**
 * Get the current user's pro status
 */
export const getProStatus = async (): Promise<ThunderboltProStatus> => {
  return {
    isProUser,
    features: isProUser ? ['search', 'web_fetch', 'weather', 'weather_forecast'] : [],
  }
}

/**
 * Check if user has access to pro features
 */
export const hasProAccess = async (): Promise<boolean> => {
  const status = await getProStatus()
  return status.isProUser
}
