type OtpError = { code?: string; message?: string }
type OtpErrorContext = 'link' | 'code'

const messages: Record<OtpErrorContext, Record<string, string>> = {
  link: {
    OTP_EXPIRED: 'This link has expired. Please request a new one.',
    INVALID_OTP: 'This link is invalid. Please request a new one.',
    TOO_MANY_ATTEMPTS: 'Too many attempts. Please request a new code.',
  },
  code: {
    OTP_EXPIRED: 'This code has expired. Please request a new one.',
    INVALID_OTP: 'Invalid code. Please try again.',
    TOO_MANY_ATTEMPTS: 'Too many attempts. Please request a new code.',
  },
}

const fallback = 'Verification failed. Please try again.'

/**
 * Returns a user-friendly message for OTP verification errors.
 * Handles OTP_EXPIRED, INVALID_OTP, and TOO_MANY_ATTEMPTS from Better Auth.
 */
export const getOtpErrorMessage = (error: OtpError, context: OtpErrorContext): string => {
  const message = error?.code ? messages[context][error.code] : undefined
  return message ?? error?.message ?? fallback
}
