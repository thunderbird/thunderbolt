/** Deep link base URL for mobile apps (iOS/Android) */
const DEEP_LINK_HOST = 'https://thunderbolt.io'

/** Platforms that support deep linking */
const DEEP_LINK_PLATFORMS = ['ios', 'android']

/**
 * Parse trusted origins from environment variable or use default
 */
export const parseTrustedOrigins = (envValue?: string, defaultOrigin = 'http://localhost:1420'): string[] => {
  const origins = envValue?.split(',').filter(Boolean)
  return origins && origins.length > 0 ? origins : [defaultOrigin]
}

/**
 * Check if the client platform supports deep linking
 */
export const isDeepLinkPlatform = (request?: Request): boolean => {
  const platform = request?.headers.get('x-client-platform')
  return platform ? DEEP_LINK_PLATFORMS.includes(platform) : false
}

/**
 * Validate and extract origin from request
 * Returns the origin if trusted, otherwise falls back to first trusted origin
 */
export const getValidatedOrigin = (trustedOrigins: string[], request?: Request): string => {
  const origin = request?.headers.get('origin')
  if (origin && trustedOrigins.includes(origin)) {
    return origin
  }
  return trustedOrigins[0]
}

/**
 * Build a magic link URL for email verification
 * Uses deep link URL for mobile platforms so the link opens the app
 */
export const buildMagicLinkUrl = (origin: string, token: string, request?: Request): string => {
  const baseUrl = isDeepLinkPlatform(request) ? DEEP_LINK_HOST : origin
  return `${baseUrl}/auth/verify?token=${encodeURIComponent(token)}`
}
