/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

/** A local sample session; it is never accepted by a server or written as an auth token. */
const sampleSession = () => ({
  user: {
    id: 'admin-local-review',
    name: 'Avery Morgan',
    email: 'avery@example.com',
    emailVerified: true,
    isAnonymous: false,
    image: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  },
  session: {
    id: 'local-review-session',
    userId: 'admin-local-review',
    token: '',
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  },
})

/** Answer frontend boot requests in memory. Unsupported operations never fall through to the network. */
export const localReviewFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const request = new Request(input, init)
  const path = new URL(request.url).pathname
  if (request.method === 'GET') {
    if (path.endsWith('/api/auth/get-session')) {
      return Response.json(sampleSession())
    }
    if (path.endsWith('/api/auth/list-sessions')) {
      return Response.json([sampleSession().session])
    }
    if (path.endsWith('/config')) {
      return Response.json({})
    }
    if (path.endsWith('/mini-apps')) {
      return Response.json({ apps: [] })
    }
    if (path.endsWith('/agents')) {
      return Response.json({ agents: [], defaultAgentId: null })
    }
  }
  return Response.json(
    { message: 'This local design review has no connected backend.', code: 'LOCAL_REVIEW_ONLY' },
    { status: 503 },
  )
}
