import { Resend } from 'resend'

/**
 * Shared Resend client instance for sending emails
 * Created once at module load to avoid multiple instances
 */
export const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null

if (!resend) {
  console.warn('⚠️ RESEND_API_KEY is not set - emails will not be sent')
}

/**
 * Check if email sending should be skipped (test/dev mode or resend not configured)
 * Throws an error if in production but resend is not configured
 * @returns true if email should be skipped, false if it should be sent
 */
export const shouldSkipEmail = (isProduction: boolean): boolean => {
  if (!resend || process.env.NODE_ENV === 'test') {
    if (isProduction && !resend) {
      throw new Error('Email service not configured')
    }
    return true
  }
  return false
}
