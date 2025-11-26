import { db } from '@/db/client'
import { betterAuth } from 'better-auth'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { magicLink } from 'better-auth/plugins'
import { Resend } from 'resend'

const resend = new Resend(process.env.RESEND_API_KEY)

if (!process.env.RESEND_API_KEY) {
  console.warn('⚠️ RESEND_API_KEY is not set - magic link emails will not be sent')
}

/**
 * Trusted origins for CORS and magic link validation
 * First origin is the default fallback for magic links
 */
const TRUSTED_ORIGINS = process.env.TRUSTED_ORIGINS?.split(',').filter(Boolean) ?? ['http://localhost:1420']

/**
 * Validate and extract origin from request
 * Returns the origin if trusted, otherwise falls back to first trusted origin
 */
const getValidatedOrigin = (request?: Request): string => {
  const origin = request?.headers.get('origin')
  if (origin && TRUSTED_ORIGINS.includes(origin)) {
    return origin
  }
  return TRUSTED_ORIGINS[0]
}

export const auth = betterAuth({
  database: drizzleAdapter(db, {
    provider: 'pg',
  }),
  trustedOrigins: TRUSTED_ORIGINS,
  plugins: [
    magicLink({
      sendMagicLink: async ({ email, token }, ctx) => {
        // Use the origin from the request if trusted, otherwise fallback to default
        const origin = getValidatedOrigin(ctx?.request)
        const magicLinkUrl = `${origin}/auth/verify?token=${encodeURIComponent(token)}`

        console.info(`📧 Sending magic link to ${email}`)
        console.info(`🔗 Magic link URL: ${magicLinkUrl}`)

        if (!process.env.RESEND_API_KEY) {
          console.error('❌ Cannot send email: RESEND_API_KEY is not configured')
          throw new Error('Email service not configured')
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

export type Auth = typeof auth
