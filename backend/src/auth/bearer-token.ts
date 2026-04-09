import { createHmac } from 'crypto'

/**
 * Verify a signed bearer token (format: `rawToken.base64Signature`) and return the raw session token.
 * Returns null if the token is unsigned, malformed, or the signature doesn't match.
 */
export const verifySignedBearerToken = (bearerValue: string, secret: string): string | null => {
  const dotIndex = bearerValue.lastIndexOf('.')
  if (dotIndex < 1) return null

  const rawToken = bearerValue.substring(0, dotIndex)
  const signature = bearerValue.substring(dotIndex + 1)

  const expected = createHmac('sha256', secret).update(rawToken).digest('base64')
  if (signature !== expected) return null

  return rawToken
}
