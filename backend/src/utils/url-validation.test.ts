import { describe, expect, it } from 'bun:test'
import { isPrivateAddress, validateSafeUrl } from './url-validation'

describe('isPrivateAddress', () => {
  // --- Blocked IPv4 ranges ---

  it.each([
    ['10.0.0.1', 'RFC 1918 (10/8)'],
    ['10.255.255.255', 'RFC 1918 (10/8 upper)'],
    ['172.16.0.1', 'RFC 1918 (172.16/12)'],
    ['172.31.255.255', 'RFC 1918 (172.16/12 upper)'],
    ['192.168.0.1', 'RFC 1918 (192.168/16)'],
    ['192.168.255.255', 'RFC 1918 (192.168/16 upper)'],
    ['127.0.0.1', 'loopback'],
    ['127.255.255.255', 'loopback upper'],
    ['169.254.169.254', 'link-local (cloud metadata)'],
    ['169.254.0.1', 'link-local'],
    ['100.64.0.1', 'CGNAT (RFC 6598)'],
    ['100.127.255.254', 'CGNAT upper bound'],
    ['198.18.0.1', 'benchmarking (RFC 2544)'],
    ['198.19.255.254', 'benchmarking upper bound'],
    ['0.0.0.0', 'unspecified'],
    ['0.0.0.1', 'unspecified range'],
    ['255.255.255.255', 'broadcast'],
    ['192.0.2.1', 'documentation (TEST-NET-1)'],
    ['198.51.100.1', 'documentation (TEST-NET-2)'],
    ['203.0.113.1', 'documentation (TEST-NET-3)'],
    ['240.0.0.1', 'reserved (future use)'],
  ])('blocks %s (%s)', (ip) => {
    expect(isPrivateAddress(ip)).toBe(true)
  })

  // --- Blocked IPv6 ranges ---

  it.each([
    ['::1', 'IPv6 loopback'],
    ['::', 'IPv6 unspecified'],
    ['fe80::1', 'IPv6 link-local'],
    ['fc00::1', 'IPv6 unique local (fc00)'],
    ['fd00::1', 'IPv6 unique local (fd00)'],
  ])('blocks %s (%s)', (ip) => {
    expect(isPrivateAddress(ip)).toBe(true)
  })

  // --- IPv4-mapped IPv6 ---

  it.each([
    ['::ffff:127.0.0.1', 'IPv4-mapped loopback (dotted)'],
    ['::ffff:7f00:1', 'IPv4-mapped loopback (hex, Bun-normalized)'],
    ['::ffff:10.0.0.1', 'IPv4-mapped private (dotted)'],
    ['::ffff:a00:1', 'IPv4-mapped private (hex)'],
    ['::ffff:169.254.169.254', 'IPv4-mapped link-local'],
    ['::ffff:100.64.0.1', 'IPv4-mapped CGNAT'],
  ])('blocks %s (%s)', (ip) => {
    expect(isPrivateAddress(ip)).toBe(true)
  })

  // --- Bracketed IPv6 ---

  it('blocks bracketed IPv6', () => {
    expect(isPrivateAddress('[::1]')).toBe(true)
    expect(isPrivateAddress('[fe80::1]')).toBe(true)
  })

  // --- Allowed addresses ---

  it.each([
    ['93.184.216.34', 'public IPv4'],
    ['8.8.8.8', 'Google DNS'],
    ['1.1.1.1', 'Cloudflare DNS'],
    ['198.17.255.255', 'just below benchmarking range'],
    ['198.20.0.0', 'just above benchmarking range'],
    ['100.63.255.255', 'just below CGNAT range'],
    ['100.128.0.0', 'just above CGNAT range'],
    ['172.15.255.255', 'just below 172.16/12'],
    ['172.32.0.0', 'just above 172.16/12'],
  ])('allows %s (%s)', (ip) => {
    expect(isPrivateAddress(ip)).toBe(false)
  })

  // --- Non-IP strings ---

  it('returns false for non-IP strings', () => {
    expect(isPrivateAddress('localhost')).toBe(false)
    expect(isPrivateAddress('example.com')).toBe(false)
    expect(isPrivateAddress('')).toBe(false)
    expect(isPrivateAddress('not-an-ip')).toBe(false)
  })
})

describe('validateSafeUrl', () => {
  it('allows valid HTTP URLs', () => {
    expect(validateSafeUrl('https://example.com')).toEqual({ valid: true })
    expect(validateSafeUrl('http://example.com/path')).toEqual({ valid: true })
  })

  it('rejects non-HTTP protocols', () => {
    expect(validateSafeUrl('ftp://files.example.com').valid).toBe(false)
    expect(validateSafeUrl('file:///etc/passwd').valid).toBe(false)
    expect(validateSafeUrl('javascript:alert(1)').valid).toBe(false)
  })

  it('rejects invalid URLs', () => {
    expect(validateSafeUrl('not-a-url').valid).toBe(false)
    expect(validateSafeUrl('').valid).toBe(false)
  })

  it('blocks localhost by default', () => {
    expect(validateSafeUrl('http://localhost/path').valid).toBe(false)
    expect(validateSafeUrl('http://127.0.0.1/path').valid).toBe(false)
  })

  it('blocks private IPs', () => {
    expect(validateSafeUrl('http://10.0.0.1/path').valid).toBe(false)
    expect(validateSafeUrl('http://192.168.1.1/path').valid).toBe(false)
    expect(validateSafeUrl('http://169.254.169.254/latest/meta-data/').valid).toBe(false)
    expect(validateSafeUrl('http://100.64.0.1/internal').valid).toBe(false)
    expect(validateSafeUrl('http://198.18.0.1/internal').valid).toBe(false)
  })
})
