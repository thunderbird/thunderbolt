import { describe, expect, it } from 'bun:test'
import { isLocalhostUrl } from './is-localhost-url'

describe('isLocalhostUrl', () => {
  describe('true cases — loopback / localhost', () => {
    it('detects localhost', () => {
      expect(isLocalhostUrl('http://localhost:11434')).toBe(true)
    })

    it('detects localhost with path', () => {
      expect(isLocalhostUrl('http://localhost/v1')).toBe(true)
    })

    it('detects 127.0.0.1', () => {
      expect(isLocalhostUrl('http://127.0.0.1/v1')).toBe(true)
    })

    it('detects 127.0.0.1 with port', () => {
      expect(isLocalhostUrl('http://127.0.0.1:8080/v1')).toBe(true)
    })

    it('detects 127.0.0.5', () => {
      expect(isLocalhostUrl('http://127.0.0.5/v1')).toBe(true)
    })

    it('detects 127.1 (WHATWG URL normalises to 127.0.0.1)', () => {
      expect(isLocalhostUrl('http://127.1/v1')).toBe(true)
    })

    it('detects ::1', () => {
      expect(isLocalhostUrl('http://[::1]/v1')).toBe(true)
    })

    it('detects 0.0.0.0', () => {
      expect(isLocalhostUrl('http://0.0.0.0/v1')).toBe(true)
    })

    it('detects foo.localhost subdomain', () => {
      expect(isLocalhostUrl('http://foo.localhost/v1')).toBe(true)
    })

    it('detects deep subdomain of .localhost', () => {
      expect(isLocalhostUrl('http://a.b.localhost:5000/v1')).toBe(true)
    })
  })

  describe('false cases — external / RFC-1918', () => {
    it('rejects api.openai.com', () => {
      expect(isLocalhostUrl('https://api.openai.com/v1')).toBe(false)
    })

    it('rejects cloud inference hostname', () => {
      expect(isLocalhostUrl('https://animal.inference.thunderbolt.io/v1')).toBe(false)
    })

    it('returns false for malformed URL without throwing', () => {
      expect(isLocalhostUrl('not a url')).toBe(false)
    })

    it('rejects RFC-1918 192.168.x.x', () => {
      expect(isLocalhostUrl('http://192.168.1.1/v1')).toBe(false)
    })

    it('rejects RFC-1918 10.x.x.x', () => {
      expect(isLocalhostUrl('http://10.0.0.1/v1')).toBe(false)
    })

    it('rejects empty string without throwing', () => {
      expect(isLocalhostUrl('')).toBe(false)
    })
  })
})
