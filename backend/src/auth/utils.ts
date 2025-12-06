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

type ResendClient = {
  emails: {
    send: (params: {
      from: string
      to: string
      template: {
        id: string
        variables: Record<string, string>
      }
    }) => Promise<{ data?: { id: string } | null; error?: { message: string } | null }>
  }
}

type SendSignInEmailParams = {
  resend: ResendClient | null
  email: string
  otp: string
  verifyUrl: string
  isProduction: boolean
}

/**
 * Send sign-in email with both OTP code and a clickable link
 */
export const sendSignInEmail = async ({
  resend,
  email,
  otp,
  verifyUrl,
  isProduction,
}: SendSignInEmailParams): Promise<void> => {
  console.info(`📧 Sending sign-in email to ${email}`)

  if (!resend) {
    if (isProduction) {
      console.error('❌ Cannot send email: RESEND_API_KEY is not configured')
      throw new Error('Email service not configured')
    }
    console.info(`🔗 [DEV] Verify URL (no email sent): ${verifyUrl}`)
    console.info(`🔢 [DEV] OTP code: ${otp}`)
    return
  }

  const { data, error } = await resend.emails.send({
    from: 'hello@auth.thunderbolt.io',
    to: email,
    template: {
      id: 'magic-link',
      variables: {
        otp_code: otp,
        magic_link: verifyUrl,
      },
    },
  })

  if (error) {
    console.error('❌ Failed to send sign-in email:', error)
    throw new Error(`Failed to send email: ${error.message}`)
  }

  console.info(`✅ Sign-in email sent successfully. ID: ${data?.id}`)
}
