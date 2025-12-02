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
 * Build a magic link URL for email verification
 * Uses deep link URL for mobile platforms so the link opens the app
 */
export const buildMagicLinkUrl = (origin: string, token: string, request?: Request): string => {
  const baseUrl = isDeepLinkPlatform(request) ? DEEP_LINK_HOST : origin
  return `${baseUrl}/auth/verify?token=${encodeURIComponent(token)}`
}

/** OTP length for email verification codes */
export const OTP_LENGTH = 6

/** OTP expiration time in seconds (5 minutes) */
export const OTP_EXPIRES_IN = 300

/**
 * Generate a cryptographically secure random numeric OTP of specified length
 */
export const generateOTP = (length: number = OTP_LENGTH): string => {
  const array = new Uint8Array(length)
  crypto.getRandomValues(array)
  // Map each byte to a digit 0-9 (using modulo to avoid bias for small ranges)
  return Array.from(array, (byte) => (byte % 10).toString()).join('')
}

/**
 * In-memory store for OTPs linked to magic link tokens
 * Maps email -> { otp, expiresAt }
 * This allows us to send a single email with both the magic link and OTP
 */
const otpStore = new Map<string, { otp: string; expiresAt: number }>()

/**
 * Store an OTP for an email address
 */
export const storeOTPForEmail = (email: string, otp: string): void => {
  otpStore.set(email, {
    otp,
    expiresAt: Date.now() + OTP_EXPIRES_IN * 1000,
  })
}

/**
 * Get and validate stored OTP for an email
 * Returns the OTP if valid, null if expired or not found
 */
export const getStoredOTP = (email: string): string | null => {
  const stored = otpStore.get(email)
  if (!stored) return null
  if (Date.now() > stored.expiresAt) {
    otpStore.delete(email)
    return null
  }
  return stored.otp
}

/**
 * Clear stored OTP for an email (after successful verification)
 */
export const clearStoredOTP = (email: string): void => {
  otpStore.delete(email)
}

type SendAuthEmailParams = {
  resend: {
    emails: {
      send: (params: {
        from: string
        to: string
        subject: string
        html: string
      }) => Promise<{ data?: { id: string } | null; error?: { message: string } | null }>
    }
  } | null
  email: string
  magicLinkUrl: string
  otp: string
  isProduction: boolean
}

/**
 * Send authentication email with both magic link and OTP code
 */
export const sendAuthEmail = async ({
  resend,
  email,
  magicLinkUrl,
  otp,
  isProduction,
}: SendAuthEmailParams): Promise<void> => {
  console.info(`📧 Sending auth email to ${email}`)

  if (!resend) {
    if (isProduction) {
      console.error('❌ Cannot send email: RESEND_API_KEY is not configured')
      throw new Error('Email service not configured')
    }
    console.info(`🔗 [DEV] Magic link URL (no email sent): ${magicLinkUrl}`)
    console.info(`🔢 [DEV] OTP code: ${otp}`)
    return
  }

  const { data, error } = await resend.emails.send({
    from: 'hello@auth.thunderbolt.io',
    to: email,
    subject: 'Sign in to Thunderbolt',
    html: `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 480px; margin: 0 auto; padding: 24px;">
        <h1 style="font-size: 24px; font-weight: 600; margin-bottom: 24px; color: #1a1a1a;">Sign in to Thunderbolt</h1>
        
        <p style="font-size: 16px; color: #4a4a4a; margin-bottom: 24px;">
          Use the code below to sign in, or click the magic link.
        </p>
        
        <div style="background: #f5f5f5; border-radius: 12px; padding: 24px; text-align: center; margin-bottom: 24px;">
          <p style="font-size: 14px; color: #6a6a6a; margin: 0 0 8px 0;">Your verification code</p>
          <p style="font-size: 32px; font-weight: 700; letter-spacing: 8px; margin: 0; color: #1a1a1a; font-family: monospace;">${otp}</p>
        </div>
        
        <p style="font-size: 14px; color: #6a6a6a; text-align: center; margin-bottom: 16px;">or</p>
        
        <a href="${magicLinkUrl}" style="display: block; background: #1a1a1a; color: white; text-decoration: none; padding: 14px 24px; border-radius: 8px; text-align: center; font-weight: 500; font-size: 16px;">
          Sign in with magic link
        </a>
        
        <p style="font-size: 12px; color: #9a9a9a; margin-top: 24px; text-align: center;">
          This code expires in 5 minutes. If you didn't request this, you can safely ignore this email.
        </p>
      </div>
    `,
  })

  if (error) {
    console.error('❌ Failed to send auth email:', error)
    throw new Error(`Failed to send email: ${error.message}`)
  }

  console.info(`✅ Auth email sent successfully. ID: ${data?.id}`)
}
