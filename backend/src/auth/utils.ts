import { sendEmail, shouldSkipEmail } from '@/lib/resend'

/** Deep link base URL for mobile apps (iOS/Android) */
const DEEP_LINK_HOST = 'https://thunderbolt.io'

/** Platforms that support deep linking */
const DEEP_LINK_PLATFORMS = ['ios', 'android']

/** Tauri app origin - always included for mobile/desktop app support */
const TAURI_ORIGIN = 'tauri://localhost'

/** Default trusted origins for development */
const DEFAULT_TRUSTED_ORIGINS = [
  'http://localhost:1420', // Vite dev server
  TAURI_ORIGIN, // Tauri app (iOS/Android/Desktop)
]

/**
 * Parse trusted origins from environment variable or use defaults
 * Always includes tauri://localhost for Tauri app support
 */
export const parseTrustedOrigins = (envValue?: string): string[] => {
  const origins = envValue?.split(',').filter(Boolean)
  const baseOrigins = origins && origins.length > 0 ? origins : DEFAULT_TRUSTED_ORIGINS

  // Always ensure tauri://localhost is included for Tauri app support
  if (!baseOrigins.includes(TAURI_ORIGIN)) {
    return [...baseOrigins, TAURI_ORIGIN]
  }

  return baseOrigins
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
 * Build a verify URL that embeds the email and OTP
 * When clicked, the frontend auto-submits the OTP via the standard emailOtp sign-in endpoint
 * Uses deep link URL for mobile platforms so the link opens the app
 */
export const buildVerifyUrl = (origin: string, email: string, otp: string, request?: Request): string => {
  const baseUrl = isDeepLinkPlatform(request) ? DEEP_LINK_HOST : origin
  const params = new URLSearchParams({ email, otp })
  return `${baseUrl}/auth/verify?${params.toString()}`
}

type SendSignInEmailParams = {
  email: string
  otp: string
  verifyUrl: string
}

/**
 * Send sign-in email with both OTP code and a clickable link
 */
export const sendSignInEmail = async ({ email, otp, verifyUrl }: SendSignInEmailParams): Promise<void> => {
  if (shouldSkipEmail()) {
    console.info(`🔗 [DEV] Verify URL (no email sent): ${verifyUrl}`)
    console.info(`🔢 [DEV] OTP code: ${otp}`)
    return
  }

  const data = await sendEmail({
    to: email,
    templateId: 'magic-link',
    variables: {
      otp_code: otp,
      magic_link: verifyUrl,
    },
  })

  console.info(`✅ Sign-in email sent successfully. ID: ${data?.id}`)
}
