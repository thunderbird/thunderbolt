/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { mock } from 'bun:test'
import * as authUtils from '@/auth/utils'
import { challengeTokenHeader } from '@/auth/otp-constants'
import { user, waitlist } from '@/db/schema'
import { eq } from 'drizzle-orm'
import type { db as DbType } from '@/db/client'
import { createTestChallenge } from './otp-challenge'
import { createTestDb } from './db'

/** Module-scoped mock that captures the OTP each time the auth flow tries to
 *  send a sign-in email. Imported as a side-effect: any test file that imports
 *  from this module gets the mock applied (mock.module is global within the
 *  test runner). */
const mockSendSignInEmail = mock((_args: { email: string; otp: string; verifyUrl: string }) => Promise.resolve())

mock.module('@/auth/utils', () => ({
  ...authUtils,
  sendSignInEmail: mockSendSignInEmail,
}))

/** Reset the captured emails. Call before each createTestApp() so multiple
 *  sign-ins in the same test file don't read each other's OTPs. */
const resetSignInMock = () => {
  mockSendSignInEmail.mockClear()
}

/** Read the OTP captured from the most recent sendVerificationOTP call. */
const captureLastOtp = (): string | undefined => {
  const calls = mockSendSignInEmail.mock.calls as unknown as Array<[{ otp?: string }]>
  return calls[calls.length - 1]?.[0]?.otp
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
  } = {},
): Promise<TestAppHandle> => {
  const { createApp } = await import('@/index')
  const { createAuth } = await import('@/auth/auth')

  const { db, cleanup: cleanupDb } = await createTestDb()

  const email = `e2e-${crypto.randomUUID()}@example.com`

  await db.insert(waitlist).values({
    id: crypto.randomUUID(),
    email,
    status: 'approved',
  })

  const auth = createAuth(db)
  const app = await createApp({
    database: db,
    fetchFn: options.fetchFn ?? globalThis.fetch,
    auth,
    upstreamWsFactory: options.upstreamWsFactory,
    proxyObservability: options.proxyObservability,
  })

  resetSignInMock()
  await auth.api.sendVerificationOTP({ body: { email, type: 'sign-in' } })
  const otp = captureLastOtp()
  if (!otp) {
    throw new Error('e2e: OTP not captured from sendVerificationOTP — check email mock setup')
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

  const users = await db.select().from(user).where(eq(user.email, email))
  if (users.length === 0) {
    throw new Error(`e2e: user ${email} was not created during sign-in`)
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
