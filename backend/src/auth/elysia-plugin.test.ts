import { describe, expect, it } from 'bun:test'
import { withSessionTokenRedacted } from './elysia-plugin'

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })

const makeHandler = (body: unknown, status = 200) =>
  withSessionTokenRedacted(() => jsonResponse(body, status))

describe('withSessionTokenRedacted', () => {
  it('should strip token from get-session response', async () => {
    const handler = makeHandler({
      session: { id: 's1', token: 'secret-token', userId: 'u1', expiresAt: '2099-01-01' },
      user: { id: 'u1', email: 'a@b.com' },
    })

    const res = await handler(new Request('http://localhost/api/auth/get-session'))
    const body = await res.json()

    expect(body.session.id).toBe('s1')
    expect(body.session.token).toBeUndefined()
    expect(body.user.email).toBe('a@b.com')
  })

  it('should strip tokens from list-sessions response', async () => {
    const handler = makeHandler([
      { id: 's1', token: 'token-1', userId: 'u1' },
      { id: 's2', token: 'token-2', userId: 'u1' },
    ])

    const res = await handler(new Request('http://localhost/api/auth/list-sessions'))
    const body = await res.json()

    expect(body).toHaveLength(2)
    expect(body[0].id).toBe('s1')
    expect(body[0].token).toBeUndefined()
    expect(body[1].token).toBeUndefined()
  })

  it('should not modify other endpoints', async () => {
    const handler = makeHandler({ session: { token: 'keep-me' } })

    const res = await handler(new Request('http://localhost/api/auth/sign-in/email'))
    const body = await res.json()

    expect(body.session.token).toBe('keep-me')
  })

  it('should pass through non-JSON responses', async () => {
    const handler = withSessionTokenRedacted(() =>
      new Response('not-json', { status: 200, headers: { 'content-type': 'text/plain' } }),
    )

    const res = await handler(new Request('http://localhost/api/auth/get-session'))
    expect(await res.text()).toBe('not-json')
  })

  it('should pass through error responses', async () => {
    const handler = makeHandler({ session: { token: 'secret' } }, 401)

    const res = await handler(new Request('http://localhost/api/auth/get-session'))
    const body = await res.json()

    expect(res.status).toBe(401)
    expect(body.session.token).toBe('secret')
  })

  it('should preserve response headers', async () => {
    const handler = withSessionTokenRedacted(() =>
      new Response(JSON.stringify({ session: { token: 'x' } }), {
        status: 200,
        headers: { 'content-type': 'application/json', 'set-auth-token': 'bearer-value' },
      }),
    )

    const res = await handler(new Request('http://localhost/api/auth/get-session'))
    expect(res.headers.get('set-auth-token')).toBe('bearer-value')
  })

  it('should remove stale content-length header', async () => {
    const original = JSON.stringify({ session: { token: 'long-token-value', id: 's1' } })
    const handler = withSessionTokenRedacted(() =>
      new Response(original, {
        status: 200,
        headers: { 'content-type': 'application/json', 'content-length': String(original.length) },
      }),
    )

    const res = await handler(new Request('http://localhost/api/auth/get-session'))
    expect(res.headers.get('content-length')).toBeNull()
  })

  it('should handle get-session with needsRefresh flag', async () => {
    const handler = makeHandler({
      session: { id: 's1', token: 'secret', userId: 'u1' },
      user: { id: 'u1' },
      needsRefresh: true,
    })

    const res = await handler(new Request('http://localhost/api/auth/get-session'))
    const body = await res.json()

    expect(body.session.token).toBeUndefined()
    expect(body.needsRefresh).toBe(true)
  })
})
