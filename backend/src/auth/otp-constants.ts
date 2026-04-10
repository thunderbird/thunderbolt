/** OTP expiry duration in seconds — used by Better Auth emailOTP config. */
export const otpExpirySeconds = 600 // 10 minutes

/** OTP expiry duration in milliseconds — used for challenge token expiry and cooldown. */
export const otpExpiryMs = otpExpirySeconds * 1000

/** HTTP header name for challenge token session binding. */
export const challengeTokenHeader = 'x-challenge-token'
