/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it, mock } from 'bun:test'
import { Elysia } from 'elysia'
import { createJwtMintRateLimit, JWT_MINT_RATE_LIMIT_MAX, JWT_MINT_RATE_LIMIT_WINDOW_MS } from './jwt-rate-limit'

type BuildAppOpts = {
  trustedProxy?: '' | 'cloudflare' | 'akamai'
  logger?: { warn: (obj: Record<string, unknown>, msg?: string) => void }
}

/** Build an app: rate-limit middleware in front of a `.all('/*')` echo handler.
 *  The handler returns 200 only if the rate limit didn't short-circuit. */
const buildApp = (clock: { now: () => number }, opts: BuildAppOpts = {}) =>
  new Elysia()
    .use(createJwtMintRateLimit({ now: clock.now, trustedProxy: opts.trustedProxy ?? '', logger: opts.logger }))
    .all('/*', () => new Response('ok', { status: 200 }))

/** Default `POST` request to the gated path with a session bearer. */
const mintReq = (init: RequestInit = {}) => new Request('http://localhost/api/auth/token', { method: 'POST', ...init })

describe('createJwtMintRateLimit', () => {
  it('allows requests up to the limit, then 429s', async () => {
    const currentTime = 1_000_000_000_000
    const app = buildApp({ now: () => currentTime })

    for (let i = 0; i < JWT_MINT_RATE_LIMIT_MAX; i++) {
      const res = await app.handle(mintReq({ headers: { Authorization: 'Bearer session-1' } }))
      expect(res.status).toBe(200)
    }

    // Next one is rejected
    const overLimit = await app.handle(mintReq({ headers: { Authorization: 'Bearer session-1' } }))
    expect(overLimit.status).toBe(429)
    expect(overLimit.headers.get('Retry-After')).toBeTruthy()
    expect(overLimit.headers.get('RateLimit-Remaining')).toBe('0')
  })

  it('only gates the /api/auth/token endpoint — other paths flow through', async () => {
    const currentTime = 1_000_000_000_000
    const app = buildApp({ now: () => currentTime })

    // Hammer a different auth endpoint past the limit
    for (let i = 0; i < JWT_MINT_RATE_LIMIT_MAX + 5; i++) {
      const res = await app.handle(
        new Request('http://localhost/api/auth/get-session', {
          method: 'POST',
          headers: { Authorization: 'Bearer session-1' },
        }),
      )
      expect(res.status).toBe(200)
    }
  })

  // ---------------------------------------------------------------------------
  // Method gate (POST-only, GET → 405)
  //
  // Better Auth's plugin exposes /token as GET upstream. We force POST so the
  // mint endpoint is not bookmarkable, prefetchable, or embeddable as
  // `<img src>` (CSRF-burn). The custom POST handler in elysia-plugin.ts is
  // the only legitimate mint path.
  // ---------------------------------------------------------------------------

  describe('method gate', () => {
    it('rejects GET on the mint path with 405 + Allow: POST', async () => {
      const app = buildApp({ now: () => 1_000_000_000_000 })
      const res = await app.handle(
        new Request('http://localhost/api/auth/token', {
          method: 'GET',
          headers: { Authorization: 'Bearer session-1' },
        }),
      )
      expect(res.status).toBe(405)
      expect(res.headers.get('Allow')).toBe('POST')
    })

    it('does not consume the rate-limit budget for blocked GETs', async () => {
      const app = buildApp({ now: () => 1_000_000_000_000 })
      // Burn 5 GETs (all should 405 without ticking the bucket)
      for (let i = 0; i < 5; i++) {
        const res = await app.handle(
          new Request('http://localhost/api/auth/token', {
            method: 'GET',
            headers: { Authorization: 'Bearer session-1' },
          }),
        )
        expect(res.status).toBe(405)
      }
      // The full POST budget is still available.
      for (let i = 0; i < JWT_MINT_RATE_LIMIT_MAX; i++) {
        const res = await app.handle(mintReq({ headers: { Authorization: 'Bearer session-1' } }))
        expect(res.status).toBe(200)
      }
    })
  })

  // ---------------------------------------------------------------------------
  // Authenticated keying — Bearer + cookie
  //
  // Two different sessions get separate buckets. Same session with a CHANGING
  // cookie blob (e.g. an analytics cookie added/removed mid-session) shares
  // the bucket — this is the load-bearing correctness fix vs the previous
  // implementation which keyed on the entire Cookie header.
  // ---------------------------------------------------------------------------

  it('keys per-session — different Bearer sessions have independent buckets', async () => {
    const currentTime = 1_000_000_000_000
    const app = buildApp({ now: () => currentTime })

    // Session 1 burns the budget
    for (let i = 0; i < JWT_MINT_RATE_LIMIT_MAX; i++) {
      await app.handle(mintReq({ headers: { Authorization: 'Bearer session-1' } }))
    }
    // Session 2 still gets its full budget
    const res = await app.handle(mintReq({ headers: { Authorization: 'Bearer session-2' } }))
    expect(res.status).toBe(200)
  })

  it('keys per-session — different cookie session_token values have independent buckets', async () => {
    const currentTime = 1_000_000_000_000
    const app = buildApp({ now: () => currentTime })

    // Cookie session A burns the budget
    for (let i = 0; i < JWT_MINT_RATE_LIMIT_MAX; i++) {
      await app.handle(mintReq({ headers: { Cookie: 'better-auth.session_token=cookie-A' } }))
    }
    // Cookie session B still gets its full budget
    const res = await app.handle(mintReq({ headers: { Cookie: 'better-auth.session_token=cookie-B' } }))
    expect(res.status).toBe(200)
  })

  it('keys on the better-auth session cookie value, not the entire Cookie blob', async () => {
    // Same session_token, but sibling cookies change between requests. The
    // bucket MUST stay stable — otherwise a sibling-cookie flipper bypasses
    // the rate limit.
    const currentTime = 1_000_000_000_000
    const app = buildApp({ now: () => currentTime })

    for (let i = 0; i < JWT_MINT_RATE_LIMIT_MAX; i++) {
      // Vary an "analytics" cookie each request — same session_token throughout
      const cookie = `analytics=${i}; better-auth.session_token=stable-session; ab_bucket=${i % 3}`
      await app.handle(mintReq({ headers: { Cookie: cookie } }))
    }
    // Even with a brand-new sibling cookie set, the same session_token must hit 429.
    const blocked = await app.handle(
      mintReq({
        headers: { Cookie: 'csrf=new; better-auth.session_token=stable-session; experiment=Z' },
      }),
    )
    expect(blocked.status).toBe(429)
  })

  it('resets the bucket after the window elapses', async () => {
    const clock = { time: 1_000_000_000_000 }
    const app = buildApp({ now: () => clock.time })

    for (let i = 0; i < JWT_MINT_RATE_LIMIT_MAX; i++) {
      await app.handle(mintReq({ headers: { Authorization: 'Bearer session-1' } }))
    }
    const blocked = await app.handle(mintReq({ headers: { Authorization: 'Bearer session-1' } }))
    expect(blocked.status).toBe(429)

    // Advance past the window
    clock.time += JWT_MINT_RATE_LIMIT_WINDOW_MS + 100
    const recovered = await app.handle(mintReq({ headers: { Authorization: 'Bearer session-1' } }))
    expect(recovered.status).toBe(200)
  })

  // ---------------------------------------------------------------------------
  // Anonymous keying (per-IP, NOT global)
  //
  // The previous implementation funnelled all credential-less mint attempts
  // into a single 'anonymous' bucket. A botnet could starve the bucket and
  // block every legitimate logged-out caller. We now key on the trusted-proxy
  // client IP; if the IP is unresolvable, we skip rate limiting (consistent
  // with createIpRateLimitMiddleware) and warn.
  // ---------------------------------------------------------------------------

  describe('anonymous (no auth) keying', () => {
    it('keys per-IP — two different anonymous IPs have independent buckets', async () => {
      const app = buildApp({ now: () => 1_000_000_000_000 }, { trustedProxy: 'cloudflare' })

      // IP A burns the budget
      for (let i = 0; i < JWT_MINT_RATE_LIMIT_MAX; i++) {
        const res = await app.handle(mintReq({ headers: { 'CF-Connecting-IP': '1.2.3.4' } }))
        expect(res.status).toBe(200)
      }
      // IP A is now blocked
      const blockedA = await app.handle(mintReq({ headers: { 'CF-Connecting-IP': '1.2.3.4' } }))
      expect(blockedA.status).toBe(429)
      // IP B still gets its full budget
      const freshB = await app.handle(mintReq({ headers: { 'CF-Connecting-IP': '5.6.7.8' } }))
      expect(freshB.status).toBe(200)
    })

    it('skips rate limiting and warns when the client IP cannot be resolved', async () => {
      const warn = mock(() => {})
      const app = buildApp({ now: () => 1_000_000_000_000 }, { trustedProxy: 'cloudflare', logger: { warn } })

      // No CF-Connecting-IP header → extractClientIp returns 'unknown' → skip
      for (let i = 0; i < JWT_MINT_RATE_LIMIT_MAX + 5; i++) {
        const res = await app.handle(mintReq())
        expect(res.status).toBe(200)
      }
      // The warn logger fired at least once for the IP-unknown branch.
      expect(warn).toHaveBeenCalled()
    })

    it('does NOT bucket all anonymous callers into a single global slot', async () => {
      // Verifies that 100 different anonymous IPs do NOT share a bucket — each
      // one independently starts at full budget.
      const app = buildApp({ now: () => 1_000_000_000_000 }, { trustedProxy: 'cloudflare' })

      for (let i = 0; i < 100; i++) {
        const res = await app.handle(
          mintReq({ headers: { 'CF-Connecting-IP': `10.0.${Math.floor(i / 256)}.${i % 256}` } }),
        )
        expect(res.status).toBe(200)
      }
    })
  })

  it('emits standard RateLimit-* headers on success', async () => {
    const currentTime = 1_000_000_000_000
    const app = buildApp({ now: () => currentTime })
    const res = await app.handle(mintReq({ headers: { Authorization: 'Bearer session-1' } }))
    expect(res.status).toBe(200)
    expect(res.headers.get('RateLimit-Limit')).toBe(String(JWT_MINT_RATE_LIMIT_MAX))
    expect(res.headers.get('RateLimit-Remaining')).toBe(String(JWT_MINT_RATE_LIMIT_MAX - 1))
    expect(res.headers.get('RateLimit-Reset')).toBeTruthy()
  })

  it('sweeps stale buckets without a separate timer', async () => {
    const clock = { time: 1_000_000_000_000 }
    const app = buildApp({ now: () => clock.time })

    // Populate one bucket
    await app.handle(mintReq({ headers: { Authorization: 'Bearer ephemeral' } }))

    // Advance past the window
    clock.time += JWT_MINT_RATE_LIMIT_WINDOW_MS + 1_000

    // A request from a different session triggers the sweep — old bucket
    // is gone, the new one is created fresh, and ephemeral can reuse the
    // namespace if it comes back later.
    const fromOther = await app.handle(mintReq({ headers: { Authorization: 'Bearer different-session' } }))
    expect(fromOther.status).toBe(200)

    // Ephemeral comes back in a fresh window — should get full budget.
    for (let i = 0; i < JWT_MINT_RATE_LIMIT_MAX; i++) {
      const res = await app.handle(mintReq({ headers: { Authorization: 'Bearer ephemeral' } }))
      expect(res.status).toBe(200)
    }
  })
})
