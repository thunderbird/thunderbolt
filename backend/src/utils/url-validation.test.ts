/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { createSafeFetch, isPrivateAddress, validateAndPin, validateSafeUrl, type DnsLookup } from './url-validation'

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

  // --- IPv6 transition addresses embedding a PRIVATE IPv4 (NAT64/6to4/Teredo) ---
  // A host with NAT64/DNS64, 6to4, or Teredo connectivity routes these to the
  // embedded IPv4, so a private embed must be blocked.
  it.each([
    ['64:ff9b::7f00:1', 'NAT64 (rfc6052) → 127.0.0.1'],
    ['64:ff9b::a9fe:a9fe', 'NAT64 → 169.254.169.254 (cloud metadata)'],
    ['64:ff9b::c0a8:1', 'NAT64 → 192.168.0.1'],
    ['2002:7f00:1::', '6to4 → 127.0.0.1'],
    ['2002:a9fe:a9fe::', '6to4 → 169.254.169.254'],
    ['::ffff:0:7f00:1', 'stateless translation (rfc6145) → 127.0.0.1'],
    ['2001:0:0:0:0:0:80ff:fffe', 'Teredo client (one’s-complement) → 127.0.0.1'],
  ])('blocks %s (%s)', (ip) => {
    expect(isPrivateAddress(ip)).toBe(true)
  })

  // The embedded-IPv4 check must NOT block transition addresses wrapping a PUBLIC
  // IPv4 — on a DNS64 deployment, legitimate IPv4-only sites resolve to 64:ff9b::<public>.
  it.each([
    ['64:ff9b::808:808', 'NAT64 → 8.8.8.8'],
    ['2002:0808:0808::', '6to4 → 8.8.8.8'],
  ])('allows %s (%s)', (ip) => {
    expect(isPrivateAddress(ip)).toBe(false)
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

  // --- SSRF advisory regression: alternate IP encodings ---
  // The WHATWG URL parser canonicalises decimal/octal/hex/short IPv4 forms to
  // dotted-quad before our check runs, so the loopback guard still fires.
  it.each([
    ['http://2130706433/', 'decimal 127.0.0.1'],
    ['http://0x7f000001/', 'hex 127.0.0.1'],
    ['http://0177.0.0.1/', 'octal-prefixed 127.0.0.1'],
    ['http://0x7f.1/', 'mixed hex/short 127.0.0.1'],
    ['http://127.1/', 'short-form 127.0.0.1'],
    ['http://127.0.0.1./', 'trailing-dot loopback'],
    ['http://0/', 'bare 0 → 0.0.0.0'],
  ])('blocks alternate IP encoding %s (%s)', (url) => {
    expect(validateSafeUrl(url).valid).toBe(false)
  })

  // --- SSRF advisory regression: bracketed IPv6 internal literals ---
  it.each([
    ['http://[::1]/', 'IPv6 loopback'],
    ['http://[::]/', 'IPv6 unspecified'],
    ['http://[::ffff:127.0.0.1]/', 'IPv4-mapped loopback'],
    ['http://[64:ff9b::7f00:1]/', 'NAT64 wrapping loopback'],
    ['http://[64:ff9b::a9fe:a9fe]/', 'NAT64 wrapping cloud metadata'],
  ])('blocks bracketed IPv6 internal literal %s (%s)', (url) => {
    expect(validateSafeUrl(url).valid).toBe(false)
  })

  // --- SSRF advisory regression: userinfo decoy must not bypass the host check ---
  it('blocks on the real host, ignoring a benign-looking userinfo decoy', () => {
    expect(validateSafeUrl('http://trusted.example.com@169.254.169.254/').valid).toBe(false)
    expect(validateSafeUrl('http://user:pass@127.0.0.1/').valid).toBe(false)
  })
})

/** Deterministic resolver for the SSRF-engine tests: avoids real network/DNS so
 *  the pin + redirect-revalidation invariants are exercised hermetically. */
const testLookup: DnsLookup = (host) => {
  if (host === 'public.test') {
    return Promise.resolve([{ address: '93.184.216.34', family: 4 }])
  }
  if (host === 'rebind.test') {
    return Promise.resolve([{ address: '169.254.169.254', family: 4 }])
  }
  if (host === 'mixed.test') {
    return Promise.resolve([
      { address: '93.184.216.34', family: 4 },
      { address: '10.0.0.1', family: 4 },
    ])
  }
  // DNS64-style synthesis: AAAA wraps an IPv4 in the NAT64 well-known prefix.
  if (host === 'nat64-private.test') {
    return Promise.resolve([{ address: '64:ff9b::7f00:1', family: 6 }])
  }
  if (host === 'nat64-public.test') {
    return Promise.resolve([{ address: '64:ff9b::808:808', family: 6 }])
  }
  return Promise.reject(new Error(`ENOTFOUND ${host}`))
}

describe('validateAndPin', () => {
  it('blocks a public hostname that resolves to a private/metadata address (DNS rebinding)', async () => {
    await expect(validateAndPin('http://rebind.test/latest/meta-data/', undefined, testLookup)).rejects.toThrow(
      /private\/internal address 169\.254\.169\.254/,
    )
  })

  it('blocks when ANY resolved address is private, even if the first is public', async () => {
    await expect(validateAndPin('http://mixed.test/', undefined, testLookup)).rejects.toThrow(/10\.0\.0\.1/)
  })

  it('blocks a hostname whose AAAA wraps a private IPv4 in a NAT64 prefix', async () => {
    await expect(validateAndPin('http://nat64-private.test/', undefined, testLookup)).rejects.toThrow(/64:ff9b::7f00:1/)
  })

  it('allows a hostname whose AAAA wraps a PUBLIC IPv4 in a NAT64 prefix (DNS64)', async () => {
    const [pinnedUrl, headers] = await validateAndPin('http://nat64-public.test/', undefined, testLookup)
    expect(pinnedUrl).toBe('http://[64:ff9b::808:808]/')
    expect(headers.get('host')).toBe('nat64-public.test')
  })

  it('pins to the resolved IP and preserves the original Host header', async () => {
    const [pinnedUrl, headers] = await validateAndPin('http://public.test/path?q=1', undefined, testLookup)
    expect(pinnedUrl).toBe('http://93.184.216.34/path?q=1')
    expect(headers.get('host')).toBe('public.test')
  })

  it('strips userinfo before pinning', async () => {
    const [pinnedUrl] = await validateAndPin('http://user:pass@public.test/x', undefined, testLookup)
    expect(pinnedUrl).toBe('http://93.184.216.34/x')
  })

  it('blocks a private IP literal without resolving DNS', async () => {
    await expect(validateAndPin('http://127.0.0.1/', undefined, testLookup)).rejects.toThrow(/private\/internal/)
  })

  it('allows a public IP literal as-is (no Host rewrite needed)', async () => {
    const [pinnedUrl] = await validateAndPin('http://93.184.216.34/ok', undefined, testLookup)
    expect(pinnedUrl).toBe('http://93.184.216.34/ok')
  })
})

const requestUrl = (input: string | URL | Request): string => {
  if (typeof input === 'string') {
    return input
  }
  return input instanceof URL ? input.toString() : input.url
}

/** Build a fetch stub that returns a queued response per call and records the
 *  URL + Host header each call was made with. */
const stubFetch = (responses: Response[]) => {
  const queue = [...responses]
  const calls: Array<{ url: string; host: string | null }> = []
  const fn = ((input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: requestUrl(input), host: new Headers(init?.headers).get('host') })
    return Promise.resolve(queue.shift())
  }) as typeof fetch
  return { fn, calls }
}

describe('createSafeFetch', () => {
  it('blocks a redirect hop that points at a loopback address', async () => {
    const { fn, calls } = stubFetch([
      new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/admin' } }),
      new Response('LEAK', { status: 200 }),
    ])
    const safeFetch = createSafeFetch(fn, testLookup)
    await expect(safeFetch('http://public.test/')).rejects.toThrow(/private\/internal/)
    // Only the first hop was attempted; the loopback hop never reached fetch.
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('http://93.184.216.34/')
  })

  it('follows a redirect to a public host, re-pinning each hop', async () => {
    const { fn, calls } = stubFetch([
      new Response(null, { status: 302, headers: { location: 'http://public.test/next' } }),
      new Response('ok', { status: 200 }),
    ])
    const safeFetch = createSafeFetch(fn, testLookup)
    const res = await safeFetch('http://public.test/')
    expect(res.status).toBe(200)
    expect(calls.map((c) => c.url)).toEqual(['http://93.184.216.34/', 'http://93.184.216.34/next'])
    expect(calls[1].host).toBe('public.test')
  })

  it('returns the redirect unfollowed when the caller asks for manual redirects', async () => {
    const { fn, calls } = stubFetch([new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/' } })])
    const safeFetch = createSafeFetch(fn, testLookup)
    const res = await safeFetch('http://public.test/', { redirect: 'manual' })
    expect(res.status).toBe(302)
    expect(calls).toHaveLength(1)
  })

  it('passes a non-redirect response straight through', async () => {
    const { fn, calls } = stubFetch([new Response('body', { status: 200 })])
    const safeFetch = createSafeFetch(fn, testLookup)
    const res = await safeFetch('http://public.test/')
    expect(res.status).toBe(200)
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('http://93.184.216.34/')
  })
})
