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
      subject: string
      html: string
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
        
        <a href="${verifyUrl}" style="display: block; background: #1a1a1a; color: white; text-decoration: none; padding: 14px 24px; border-radius: 8px; text-align: center; font-weight: 500; font-size: 16px;">
          Sign in with magic link
        </a>
        
        <p style="font-size: 12px; color: #9a9a9a; margin-top: 24px; text-align: center;">
          This code expires in 5 minutes. If you didn't request this, you can safely ignore this email.
        </p>
      </div>
    `,
  })

  if (error) {
    console.error('❌ Failed to send sign-in email:', error)
    throw new Error(`Failed to send email: ${error.message}`)
  }

  console.info(`✅ Sign-in email sent successfully. ID: ${data?.id}`)
}
