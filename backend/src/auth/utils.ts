/**
 * Parse trusted origins from environment variable or use default
 */
export const parseTrustedOrigins = (envValue?: string, defaultOrigin = 'http://localhost:1420'): string[] => {
  const origins = envValue?.split(',').filter(Boolean)
  return origins && origins.length > 0 ? origins : [defaultOrigin]
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
 */
export const buildMagicLinkUrl = (origin: string, token: string): string => {
  return `${origin}/auth/verify?token=${encodeURIComponent(token)}`
}
