/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { mock } from 'bun:test'
import type { SearchExaClient } from '@/api/search'
import { createAuth } from '@/auth/auth'
import { challengeTokenHeader } from '@/auth/otp-constants'
import { session as sessionTable, user, waitlist } from '@/db/schema'
import { createApp } from '@/index'
import { eq } from 'drizzle-orm'
import type { db as DbType } from '@/db/client'
import type { DnsLookup } from '@/utils/url-validation'
import { createTestChallenge } from './otp-challenge'
import { createTestDb } from './db'

/** Deterministic DNS resolver for e2e tests. Resolves `private.test` to a
 *  private address (so SSRF blocks fire) and everything else to a public IP.
 *  Injected as a `createApp` dep — replaces the `mock.module('node:dns')`
 *  pattern, which leaks across test files (see docs/development/testing.md). */
export const e2eDnsLookup: DnsLookup = (host) => {
  if (host === 'private.test') {
    return Promise.resolve([{ address: '192.168.1.1', family: 4 }])
  }
  return Promise.resolve([{ address: '1.2.3.4', family: 4 }])
}

/** Result of starting an e2e test app — the running Elysia app, a real
 *  authenticated bearer token, the DB handle, and a cleanup function. */
export type TestAppHandle = {
  app: {
    handle: (req: Request) => Promise<Response>
    listen: (port: number | { port: number; hostname?: string }, callback?: () => void) => unknown
    stop: () => Promise<void> | void
    server: { port: number; hostname: string } | null
  }
  db: typeof DbType
  bearerToken: string
  email: string
  cleanup: () => Promise<void>
}

/**
 * Create an authenticated end-to-end test harness around the real Elysia app.
 *
 * - Spins up a fresh PGlite-backed DB transaction.
 * - Pre-creates a waitlist-approved test user.
 * - Captures the sign-in OTP via a module-level email mock.
 * - Calls the real signInEmailOTP endpoint and extracts a bearer token.
 *
 * Cleanup rolls back the DB transaction; the app object itself is in-process.
 */
export const createTestApp = async (
  options: {
    fetchFn?: typeof fetch
    upstreamWsFactory?: (url: string, protocols?: string[]) => WebSocket
    proxyObservability?: import('@/proxy/observability').ObservabilityRecorder
    dnsLookup?: DnsLookup
    searchExaClient?: SearchExaClient | null
  } = {},
): Promise<TestAppHandle> => {
  const { db, cleanup: cleanupDb } = await createTestDb()

  const email = `e2e-${crypto.randomUUID()}@example.com`

  await db.insert(waitlist).values({
    id: crypto.randomUUID(),
    email,
    status: 'approved',
  })

  // Per-test capture: each createTestApp run gets its own auth instance with a
  // captured `sendSignInEmail`. This is dependency injection (not `mock.module`)
  // so it never leaks to other test files (see docs/development/testing.md).
  const captureSignInEmail = mock((_args: { email: string; otp: string; verifyUrl: string }) => Promise.resolve())
  const auth = createAuth(db, { sendSignInEmail: captureSignInEmail })
  const app = await createApp({
    database: db,
    fetchFn: options.fetchFn ?? globalThis.fetch,
    auth,
    upstreamWsFactory: options.upstreamWsFactory,
    proxyObservability: options.proxyObservability,
    dnsLookup: options.dnsLookup ?? e2eDnsLookup,
    searchExaClient: options.searchExaClient,
  })

  await auth.api.sendVerificationOTP({ body: { email, type: 'sign-in' } })
  const lastCall = captureSignInEmail.mock.calls.at(-1) as [{ otp?: string }] | undefined
  const otp = lastCall?.[0]?.otp
  if (!otp) {
    throw new Error('e2e: OTP not captured from sendVerificationOTP — check email dep injection')
  }

  const challengeToken = await createTestChallenge(db, email)

  const signInResp = await auth.api.signInEmailOTP({
    body: { email, otp },
    headers: new Headers({ [challengeTokenHeader]: challengeToken }),
    asResponse: true,
  })

  if (!signInResp.ok) {
    const text = await signInResp.text().catch(() => '')
    throw new Error(`e2e: signInEmailOTP failed (${signInResp.status}): ${text}`)
  }

  const bearerToken = signInResp.headers.get('set-auth-token')
  if (!bearerToken) {
    throw new Error('e2e: bearer token missing from set-auth-token response header')
  }

  const users = await db.select({ id: user.id }).from(user).where(eq(user.email, email)).limit(1)
  if (users.length === 0) {
    throw new Error(`e2e: user ${email} was not created during sign-in`)
  }

  // Verify the session row backing the bearer is actually persisted before
  // returning. Without this, a race between sign-in's cookie-set and the
  // session insert leaves the bearer un-validatable, surfacing as a 401 on
  // the first authenticated request from the test (the failure looks like a
  // proxy/auth bug but is a setup race). Better-auth signs the bearer as
  // `<sessionToken>.<hmac>`, so the row's `token` column is the prefix.
  const sessionToken = bearerToken.split('.')[0]
  const sessions = await db
    .select({ id: sessionTable.id })
    .from(sessionTable)
    .where(eq(sessionTable.token, sessionToken))
    .limit(1)
  if (sessions.length === 0) {
    throw new Error(`e2e: session row for bearer not visible in DB after sign-in (token=${sessionToken})`)
  }

  return {
    app: app as unknown as TestAppHandle['app'],
    db,
    bearerToken,
    email,
    cleanup: cleanupDb,
  }
}

/** Build the Authorization header for a test request. */
export const authHeaders = (bearerToken: string): Record<string, string> => ({
  Authorization: `Bearer ${bearerToken}`,
})

/** A virtual upstream — no real port. The proxy's pinned fetch is intercepted
 *  by `createUpstreamRouter` and routed here based on the request's Host header. */
export type TestUpstream = {
  /** The public origin the proxy "thinks" it's calling, e.g. https://upstream.test */
  publicUrl: string
  /** All requests this upstream received, in arrival order. */
  requests: Array<{
    method: string
    url: string
    headers: Headers
    bodyBytes: Uint8Array
  }>
  /** Internal — the upstream router calls this. */
  serve: (req: Request) => Promise<Response>
}

export const createTestUpstream = (
  hostname: string,
  handler: (req: Request) => Response | Promise<Response>,
): TestUpstream => {
  const requests: TestUpstream['requests'] = []
  return {
    publicUrl: `https://${hostname}`,
    requests,
    serve: async (req) => {
      // Capture body bytes before the handler consumes them.
      const cloned = req.clone()
      const buf = await cloned.arrayBuffer()
      requests.push({
        method: req.method,
        url: req.url,
        headers: new Headers(req.headers),
        bodyBytes: new Uint8Array(buf),
      })
      return handler(req)
    },
  }
}

/**
 * Build a fetchFn for createApp that routes pinned-IP URLs to the right test
 * upstream based on the inbound request's Host header. Combined with the DNS
 * mock, this lets the proxy's full SSRF + pin pipeline run while body bytes
 * still reach an in-process handler.
 */
export const createUpstreamRouter = (upstreams: Record<string, TestUpstream>): typeof fetch => {
  const router = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const inputUrl = input instanceof Request ? input.url : input.toString()
    const headers = new Headers(input instanceof Request ? input.headers : init?.headers)
    const hostHeader = headers.get('host')

    const parsed = new URL(inputUrl)
    const hostname = hostHeader ?? parsed.hostname
    const upstream = upstreams[hostname]
    if (!upstream) {
      throw new Error(`No test upstream registered for hostname ${hostname} (called ${inputUrl})`)
    }

    const publicUrl = new URL(parsed.toString())
    publicUrl.hostname = hostname

    const body = init?.body ?? (input instanceof Request ? (input as Request).body : null)
    const upstreamReq = new Request(publicUrl.toString(), {
      method: init?.method ?? (input instanceof Request ? input.method : 'GET'),
      headers,
      body: body as BodyInit | null,
      // @ts-expect-error -- Bun supports duplex:'half'
      duplex: 'half',
    })

    return upstream.serve(upstreamReq)
  }

  return Object.assign(router, { preconnect: () => {} }) as unknown as typeof fetch
}
