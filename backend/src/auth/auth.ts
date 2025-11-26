import type { db as DbType } from '@/db/client'
import { betterAuth } from 'better-auth'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { magicLink } from 'better-auth/plugins'
import { Resend } from 'resend'
import { buildMagicLinkUrl, getValidatedOrigin, parseTrustedOrigins } from './utils'

const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null

if (!resend) {
  console.warn('⚠️ RESEND_API_KEY is not set - magic link emails will not be sent')
}

/**
 * Trusted origins for CORS and magic link validation
 * First origin is the default fallback for magic links
 */
const TRUSTED_ORIGINS = parseTrustedOrigins(process.env.TRUSTED_ORIGINS)

/**
 * Create a Better Auth instance with the provided database
 * This factory pattern allows tests to inject their own database
 */
export const createAuth = (database: typeof DbType) =>
  betterAuth({
    database: drizzleAdapter(database, {
      provider: 'pg',
    }),
    trustedOrigins: TRUSTED_ORIGINS,
    plugins: [
      magicLink({
        sendMagicLink: async ({ email, token }, ctx) => {
          // Use the origin from the request if trusted, otherwise fallback to default
          const origin = getValidatedOrigin(TRUSTED_ORIGINS, ctx?.request)
          const magicLinkUrl = buildMagicLinkUrl(origin, token)

          console.info(`📧 Sending magic link to ${email}`)

          if (!resend) {
            if (process.env.NODE_ENV === 'production') {
              console.error('❌ Cannot send email: RESEND_API_KEY is not configured')
              throw new Error('Email service not configured')
            }
            console.info(`🔗 [DEV] Magic link URL (no email sent): ${magicLinkUrl}`)
            return
          }

          const { data, error } = await resend.emails.send({
            from: 'hello@auth.thunderbolt.io',
            to: email,
            subject: 'Sign in to Thunderbolt',
            html: `<p>Click <a href="${magicLinkUrl}">here</a> to sign in to Thunderbolt.</p>`,
          })

          if (error) {
            console.error('❌ Failed to send magic link email:', error)
            throw new Error(`Failed to send email: ${error.message}`)
          }

          console.info(`✅ Magic link email sent successfully. ID: ${data?.id}`)
        },
        expiresIn: 300, // 5 minutes
      }),
    ],
  })

export type Auth = ReturnType<typeof createAuth>
