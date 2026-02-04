import { sendEmail, shouldSkipEmail } from '@/lib/resend'

/**
 * Tracks emails that should receive the waitlist-approved template instead of magic-link.
 * Used when triggering OTP from the waitlist form for approved users.
 */
const waitlistApprovedEmails = new Set<string>()

/** Mark an email to receive the waitlist-approved template on next OTP send */
export const markWaitlistApproved = (email: string): void => {
  waitlistApprovedEmails.add(email.toLowerCase())
}

/** Clear the waitlist-approved flag for an email (e.g., on OTP send failure) */
export const clearWaitlistApproved = (email: string): void => {
  waitlistApprovedEmails.delete(email.toLowerCase())
}

/** Check and consume the waitlist-approved flag for an email */
export const consumeWaitlistApproved = (email: string): boolean => {
  const normalized = email.toLowerCase()
  if (waitlistApprovedEmails.has(normalized)) {
    waitlistApprovedEmails.delete(normalized)
    return true
  }
  return false
}

/** Deep link base URL for mobile apps (iOS/Android) */
const deepLinkHost = 'https://thunderbolt.io'

/** Platforms that support deep linking */
const deepLinkPlatforms = ['ios', 'android']

/** Tauri app origin - always included for mobile/desktop app support */
const tauriOrigin = 'tauri://localhost'

/** Default trusted origins for development */
const defaultTrustedOrigins = [
  'http://localhost:1420', // Vite dev server
  tauriOrigin, // Tauri app (iOS/Android/Desktop)
]

/**
 * Parse trusted origins from environment variable or use defaults
 * Always includes tauri://localhost for Tauri app support
 */
export const parseTrustedOrigins = (envValue?: string): string[] => {
  const origins = envValue?.split(',').filter(Boolean)
  const baseOrigins = origins && origins.length > 0 ? origins : defaultTrustedOrigins

  // Always ensure tauri://localhost is included for Tauri app support
  if (!baseOrigins.includes(tauriOrigin)) {
    return [...baseOrigins, tauriOrigin]
  }

  return baseOrigins
}

/**
 * Check if the client platform supports deep linking
 */
export const isDeepLinkPlatform = (request?: Request): boolean => {
  const platform = request?.headers.get('x-client-platform')
  return platform ? deepLinkPlatforms.includes(platform) : false
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
  const baseUrl = isDeepLinkPlatform(request) ? deepLinkHost : origin
  const params = new URLSearchParams({ email, otp })
  return `${baseUrl}/auth/verify?${params.toString()}`
}

type SendSignInEmailParams = {
  email: string
  otp: string
  verifyUrl: string
}

/**
 * Send sign-in email with both OTP code and a clickable link.
 * Uses 'waitlist-approved' template if the email was marked via markWaitlistApproved(),
 * otherwise uses the standard 'magic-link' template.
 */
export const sendSignInEmail = async ({ email, otp, verifyUrl }: SendSignInEmailParams): Promise<void> => {
  const isWaitlistApproved = consumeWaitlistApproved(email)
  const templateId = isWaitlistApproved ? 'waitlist-approved' : 'magic-link'

  if (shouldSkipEmail()) {
    console.info(`🔗 [DEV] Verify URL (no email sent): ${verifyUrl}`)
    console.info(`🔢 [DEV] OTP code: ${otp}`)
    console.info(`📧 [DEV] Template: ${templateId}`)
    return
  }

  const data = await sendEmail({
    to: email,
    templateId,
    variables: {
      otp_code: otp,
      magic_link: verifyUrl,
    },
  })

  console.info(`✅ Sign-in email sent successfully (${templateId}). ID: ${data?.id}`)
}
