import { describe, expect, it } from 'bun:test'
import { validateOidcRedirectUrl } from './oidc-redirect'

describe('validateOidcRedirectUrl', () => {
  it('accepts valid HTTPS OIDC provider URL', () => {
    const url = validateOidcRedirectUrl('https://auth.okta.com/authorize?client_id=abc&response_type=code')
    expect(url.hostname).toBe('auth.okta.com')
  })

  it('accepts HTTPS Microsoft login URL', () => {
    const url = validateOidcRedirectUrl('https://login.microsoftonline.com/common/oauth2/v2.0/authorize')
    expect(url.hostname).toBe('login.microsoftonline.com')
  })

  it('accepts HTTP localhost for development', () => {
    const url = validateOidcRedirectUrl('http://localhost:8080/authorize')
    expect(url.hostname).toBe('localhost')
  })

  it('rejects javascript: protocol injection', () => {
    expect(() => validateOidcRedirectUrl('javascript:alert(1)')).toThrow()
  })

  it('rejects data: URI injection', () => {
    expect(() => validateOidcRedirectUrl('data:text/html,<script>alert(1)</script>')).toThrow()
  })

  it('rejects HTTP on non-localhost', () => {
    expect(() => validateOidcRedirectUrl('http://evil.com/phish')).toThrow('HTTPS')
  })

  it('rejects empty string', () => {
    expect(() => validateOidcRedirectUrl('')).toThrow()
  })

  it('rejects invalid URL', () => {
    expect(() => validateOidcRedirectUrl('not-a-url')).toThrow()
  })

  it('accepts HTTP on 127.0.0.1 for development', () => {
    const url = validateOidcRedirectUrl('http://127.0.0.1:8080/authorize')
    expect(url.hostname).toBe('127.0.0.1')
  })

  it('rejects javascript://localhost/ despite localhost hostname', () => {
    expect(() => validateOidcRedirectUrl('javascript://localhost/alert(1)')).toThrow()
  })

  it('accepts URL matching expected origin', () => {
    const url = validateOidcRedirectUrl('https://auth.okta.com/authorize?client_id=abc', 'https://auth.okta.com')
    expect(url.hostname).toBe('auth.okta.com')
  })

  it('rejects URL with mismatched origin', () => {
    expect(() => validateOidcRedirectUrl('https://evil.com/phish', 'https://auth.okta.com')).toThrow('origin mismatch')
  })

  it('accepts any HTTPS URL when no expected origin provided', () => {
    const url = validateOidcRedirectUrl('https://anything.com/path')
    expect(url.hostname).toBe('anything.com')
  })
})
