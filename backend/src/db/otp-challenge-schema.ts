/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

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
