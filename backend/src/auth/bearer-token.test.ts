import { createHmac } from 'crypto'
import { describe, expect, it } from 'bun:test'
import { signBearerToken, verifySignedBearerToken } from './bearer-token'

const secret = 'test-secret-at-least-32-chars-long!!'

const sign = (token: string, s = secret): string => {
  const sig = createHmac('sha256', s).update(token).digest('base64')
  return `${token}.${sig}`
}

describe('signBearerToken', () => {
  it('produces rawToken.base64Signature format', () => {
    const signed = signBearerToken('my-token', secret)
    const dotIndex = signed.lastIndexOf('.')
    expect(dotIndex).toBeGreaterThan(0)
    expect(signed.substring(0, dotIndex)).toBe('my-token')
    // Signature is valid base64
    const sig = signed.substring(dotIndex + 1)
    expect(Buffer.from(sig, 'base64').toString('base64')).toBe(sig)
  })

  it('produces deterministic output for same input', () => {
    const a = signBearerToken('deterministic-test', secret)
    const b = signBearerToken('deterministic-test', secret)
    expect(a).toBe(b)
  })

  it('produces different signatures for different tokens', () => {
    const a = signBearerToken('token-a', secret)
    const b = signBearerToken('token-b', secret)
    expect(a).not.toBe(b)
  })

  it('produces different signatures for different secrets', () => {
    const a = signBearerToken('same-token', secret)
    const b = signBearerToken('same-token', 'different-secret-at-least-32-chars!!')
    expect(a).not.toBe(b)
  })

  it('handles tokens containing dots', () => {
    const signed = signBearerToken('part1.part2.part3', secret)
    expect(signed.startsWith('part1.part2.part3.')).toBe(true)
  })
})

describe('signBearerToken + verifySignedBearerToken round-trip', () => {
  it('verify accepts tokens produced by sign', () => {
    const raw = 'session-token-abc123'
    const signed = signBearerToken(raw, secret)
    expect(verifySignedBearerToken(signed, secret)).toBe(raw)
  })

  it('round-trips tokens containing dots', () => {
    const raw = 'a.b.c.d'
    const signed = signBearerToken(raw, secret)
    expect(verifySignedBearerToken(signed, secret)).toBe(raw)
  })

  it('verify rejects sign output when verified with wrong secret', () => {
    const signed = signBearerToken('my-token', secret)
    expect(verifySignedBearerToken(signed, 'wrong-secret-at-least-32-chars-long!!')).toBeNull()
  })

  it('round-trips long tokens', () => {
    const raw = 'a'.repeat(500)
    const signed = signBearerToken(raw, secret)
    expect(verifySignedBearerToken(signed, secret)).toBe(raw)
  })

  it('round-trips tokens with special characters', () => {
    const raw = 'token+with/special=chars'
    const signed = signBearerToken(raw, secret)
    expect(verifySignedBearerToken(signed, secret)).toBe(raw)
  })
})

describe('verifySignedBearerToken', () => {
  it('returns raw token for a valid signed token', () => {
    expect(verifySignedBearerToken(sign('my-session-token'), secret)).toBe('my-session-token')
  })

  it('returns null when signed with wrong secret', () => {
    const signed = sign('my-session-token', 'wrong-secret-at-least-32-chars-long!!')
    expect(verifySignedBearerToken(signed, secret)).toBeNull()
  })

  it('returns null when token has no dot', () => {
    expect(verifySignedBearerToken('no-dot-token', secret)).toBeNull()
  })

  it('returns null for empty signature (token.)', () => {
    expect(verifySignedBearerToken('my-token.', secret)).toBeNull()
  })

  it('returns null for signature with incorrect length', () => {
    expect(verifySignedBearerToken('my-token.dG9vc2hvcnQ', secret)).toBeNull()
  })

  it('returns null for dot-only input', () => {
    expect(verifySignedBearerToken('.', secret)).toBeNull()
  })

  it('returns null for empty string', () => {
    expect(verifySignedBearerToken('', secret)).toBeNull()
  })

  it('handles token that itself contains dots', () => {
    const token = 'part1.part2.part3'
    const signed = sign(token)
    expect(verifySignedBearerToken(signed, secret)).toBe(token)
  })
})
