import { db } from '@/db/client'
import { betterAuth } from 'better-auth'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { magicLink } from 'better-auth/plugins'
import { Resend } from 'resend'

const resend = new Resend(process.env.RESEND_API_KEY)

export const auth = betterAuth({
  database: drizzleAdapter(db, {
    provider: 'pg',
  }),
  trustedOrigins: process.env.TRUSTED_ORIGINS?.split(',') ?? ['http://localhost:5173'],
  plugins: [
    magicLink({
      sendMagicLink: async ({ email, url }) => {
        await resend.emails.send({
          from: 'onboarding@resend.dev',
          to: email,
          subject: 'Sign in to Thunderbolt',
          html: `<p>Click <a href="${url}">here</a> to sign in to Thunderbolt.</p>`,
        })
      },
      expiresIn: 300, // 5 minutes
    }),
  ],
})

export type Auth = typeof auth
