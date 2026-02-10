import { afterEach, describe, expect, it } from 'bun:test'
import { PR_PREVIEW_HOST_REGEX, isPrPreview } from './platform'

describe('PR_PREVIEW_HOST_REGEX', () => {
  it('matches thunderbolt-pr-{number}.onrender.com hostnames', () => {
    expect(PR_PREVIEW_HOST_REGEX.test('thunderbolt-pr-368.onrender.com')).toBe(true)
    expect(PR_PREVIEW_HOST_REGEX.test('thunderbolt-pr-1.onrender.com')).toBe(true)
    expect(PR_PREVIEW_HOST_REGEX.test('thunderbolt-pr-9999.onrender.com')).toBe(true)
  })

  it('rejects non-matching hostnames', () => {
    expect(PR_PREVIEW_HOST_REGEX.test('thunderbolt.onrender.com')).toBe(false)
    expect(PR_PREVIEW_HOST_REGEX.test('thunderbolt-pr.onrender.com')).toBe(false)
    expect(PR_PREVIEW_HOST_REGEX.test('thunderbolt-pr-368x.onrender.com')).toBe(false)
    expect(PR_PREVIEW_HOST_REGEX.test('localhost')).toBe(false)
    expect(PR_PREVIEW_HOST_REGEX.test('')).toBe(false)
  })
})

describe('isPrPreview', () => {
  const originalLocation = window.location

  afterEach(() => {
    Object.defineProperty(window, 'location', {
      value: originalLocation,
      configurable: true,
      writable: true,
    })
  })

  it('returns true when hostname matches PR preview pattern', () => {
    Object.defineProperty(window, 'location', {
      value: { ...originalLocation, hostname: 'thunderbolt-pr-368.onrender.com' },
      configurable: true,
      writable: true,
    })
    expect(isPrPreview()).toBe(true)
  })

  it('returns false when hostname does not match', () => {
    Object.defineProperty(window, 'location', {
      value: { ...originalLocation, hostname: 'localhost' },
      configurable: true,
      writable: true,
    })
    expect(isPrPreview()).toBe(false)
  })
})
