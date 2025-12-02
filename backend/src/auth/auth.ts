import type { db as DbType } from '@/db/client'
import { betterAuth } from 'better-auth'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { emailOTP, magicLink } from 'better-auth/plugins'
import { Resend } from 'resend'
import {
  buildMagicLinkUrl,
  clearStoredOTP,
  generateOTP,
  getStoredOTP,
  getValidatedOrigin,
  parseTrustedOrigins,
  sendAuthEmail,
  storeOTPForEmail,
} from './utils'

const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null

if (!resend) {
  console.warn('⚠️ RESEND_API_KEY is not set - auth emails will not be sent')
}

/**
 * Trusted origins for CORS and magic link validation
 * First origin is the default fallback for magic links
 */
const trustedOrigins = parseTrustedOrigins(process.env.TRUSTED_ORIGINS)

/**
 * Create a Better Auth instance with the provided database
 * This factory pattern allows tests to inject their own database
 */
export const createAuth = (database: typeof DbType) =>
  betterAuth({
    database: drizzleAdapter(database, {
      provider: 'pg',
    }),
    trustedOrigins: trustedOrigins,
    plugins: [
      magicLink({
        sendMagicLink: async ({ email, token }, ctx) => {
          // Use the origin from the request if trusted, otherwise fallback to default
          const origin = getValidatedOrigin(trustedOrigins, ctx?.request)
          // Use deep link URL for mobile platforms so the email opens the app
          const magicLinkUrl = buildMagicLinkUrl(origin, token, ctx?.request)

          // Generate an OTP to include in the same email
          const otp = generateOTP()

          // Store the OTP so it can be verified via our custom flow
          storeOTPForEmail(email, otp)

          // Send email with both magic link and OTP
          await sendAuthEmail({
            resend,
            email,
            magicLinkUrl,
            otp,
            isProduction: process.env.NODE_ENV === 'production',
          })
        },
        expiresIn: 300, // 5 minutes
      }),
      emailOTP({
        otpLength: 6,
        expiresIn: 300, // 5 minutes
        // Custom OTP generation that returns the OTP we already stored
        // This ensures the emailOTP plugin uses the same OTP we sent in the magic link email
        generateOTP: ({ email }) => {
          // Return the OTP we already generated and stored when sending the magic link
          const storedOtp = getStoredOTP(email)
          if (storedOtp) {
            return storedOtp
          }
          // If no stored OTP (shouldn't happen in normal flow), generate a new one
          return generateOTP()
        },
        sendVerificationOTP: async ({ email, otp, type }) => {
          // For sign-in type, don't send a separate email - the OTP was already sent with the magic link
          if (type === 'sign-in') {
            // Store the OTP in case it wasn't already stored (e.g., if emailOTP is called directly)
            storeOTPForEmail(email, otp)
            console.info(`📧 OTP for sign-in stored for ${email} (no separate email - use magic link email)`)
            return
          }

          // For other types (email-verification, forget-password), send a standalone OTP email
          console.info(`📧 Sending ${type} OTP to ${email}`)

          if (!resend) {
            if (process.env.NODE_ENV === 'production') {
              console.error('❌ Cannot send email: RESEND_API_KEY is not configured')
              throw new Error('Email service not configured')
            }
            console.info(`🔢 [DEV] OTP code (no email sent): ${otp}`)
            return
          }

          const subject = type === 'email-verification' ? 'Verify your email' : 'Reset your password'

          await resend.emails.send({
            from: 'hello@auth.thunderbolt.io',
            to: email,
            subject,
            html: `
              <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 480px; margin: 0 auto; padding: 24px;">
                <h1 style="font-size: 24px; font-weight: 600; margin-bottom: 24px; color: #1a1a1a;">${subject}</h1>
                <div style="background: #f5f5f5; border-radius: 12px; padding: 24px; text-align: center; margin-bottom: 24px;">
                  <p style="font-size: 14px; color: #6a6a6a; margin: 0 0 8px 0;">Your verification code</p>
                  <p style="font-size: 32px; font-weight: 700; letter-spacing: 8px; margin: 0; color: #1a1a1a; font-family: monospace;">${otp}</p>
                </div>
                <p style="font-size: 12px; color: #9a9a9a; margin-top: 24px; text-align: center;">
                  This code expires in 5 minutes.
                </p>
              </div>
            `,
          })
        },
      }),
    ],
  })

/**
 * Verify OTP and clear it from store after successful verification
 * Called after emailOTP.verifyEmail succeeds
 */
export const clearOTPAfterVerification = (email: string): void => {
  clearStoredOTP(email)
}

export type Auth = ReturnType<typeof createAuth>
