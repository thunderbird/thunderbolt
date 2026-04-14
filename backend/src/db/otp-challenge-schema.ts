import { pgTable, text, timestamp } from 'drizzle-orm/pg-core'

/**
 * Tracks challenge tokens for OTP session binding.
 * Each token is returned to the client that requested an OTP
 * and must be presented when verifying the OTP. This prevents
 * an attacker from brute-forcing OTPs without intercepting
 * the victim's client response.
 */
export const otpChallenge = pgTable('otp_challenge', {
  id: text('id').primaryKey(),
  email: text('email').notNull().unique(),
  challengeToken: text('challenge_token').notNull(),
  expiresAt: timestamp('expires_at').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
})
