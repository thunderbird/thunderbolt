/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type React from 'react'
import { Resend, type ErrorResponse } from 'resend'

/**
 * Sender address for all outgoing emails, and the contact address in their
 * footer.
 *
 * Configurable because a self-hosted deployment cannot use this default even
 * with its own `RESEND_API_KEY`: Resend only sends from a domain that account
 * has verified, so an operator who follows the setup docs still has every send
 * rejected. `||` rather than `??` so an env var present-but-empty (the usual
 * docker-compose shape) falls back instead of producing an empty sender.
 */
export const emailFrom = process.env.EMAIL_FROM || 'hello@auth.thunderbolt.io'

/**
 * Shared Resend client instance for sending emails
 * Created once at module load to avoid multiple instances
 */
const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null

if (!resend) {
  console.warn('⚠️ RESEND_API_KEY is not set - emails will not be sent')
}

/**
 * Check if email sending should be skipped (test/dev mode or resend not configured)
 * Throws an error if in production but resend is not configured
 * @returns true if email should be skipped, false if it should be sent
 */
export const shouldSkipEmail = (): boolean => {
  const isProduction = process.env.NODE_ENV === 'production'
  if (!resend || process.env.NODE_ENV === 'test') {
    if (isProduction && !resend) {
      throw new Error('Email service not configured')
    }
    return true
  }
  return false
}

/** Whether a real email provider is configured; public forms must never simulate delivery. */
export const isEmailConfigured = (): boolean => resend !== null

export type SendEmailParams = {
  to: string
  from?: string
  subject: string
  replyTo?: string
  react: React.ReactElement
}

/**
 * A send the provider rejected or could not complete. `message` carries the provider's own
 * explanation, which is what makes a failed sign-in email diagnosable. `providerCode` and
 * `providerStatus` identify the failure without that text, for callers that must not log it.
 */
export class EmailDeliveryError extends Error {
  readonly providerCode: ErrorResponse['name']
  readonly providerStatus: number | null

  constructor({ message, name, statusCode }: ErrorResponse) {
    super(`Failed to send email: ${message}`)
    this.name = 'EmailDeliveryError'
    this.providerCode = name
    this.providerStatus = statusCode
  }
}

/** The one Resend call this module makes, so a test can pass a stand-in client. */
type EmailClient = { emails: Pick<Resend['emails'], 'send'> }

/**
 * Send an email using a React Email component.
 * Uses the default sender address unless overridden.
 * @throws Error when no provider is configured. Callers that can run without one check
 *   `shouldSkipEmail` or `isEmailConfigured` first.
 * @throws EmailDeliveryError when the provider rejects the email or cannot be reached.
 */
export const sendEmail = async (
  { to, from = emailFrom, subject, react, replyTo }: SendEmailParams,
  client: EmailClient | null = resend,
) => {
  if (!client) {
    throw new Error('Email service not configured')
  }

  const { data, error } = await client.emails.send({ from, to, subject, react, replyTo })

  if (error) {
    throw new EmailDeliveryError(error)
  }

  return data
}
