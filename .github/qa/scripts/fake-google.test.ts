/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterAll, describe, expect, it } from 'bun:test'
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { createFakeGoogle, fakeGoogleClientId, fakeGoogleClientSecret } from './fake-google'

const scope = ['openid', 'gmail.readonly', 'gmail.compose', 'calendar.readonly']
  .map((name) => (name === 'openid' ? name : `https://www.googleapis.com/auth/${name}`))
  .join(' ')
const verifier = 'a-pkce-verifier-that-is-long-enough-for-the-test'

// `test:qa` runs from this directory, so the root bunfig's happy-dom preload (its own fetch) stays out.
const fake = createFakeGoogle(0)
afterAll(() => fake.stop(true))

type Reply = { status: number; headers: Headers; body: string }
type Call = { method?: string; headers?: Record<string, string>; body?: string }

/** A real HTTP call to the fake that never follows redirects. */
const call = async (path: string, { method = 'GET', headers = {}, body }: Call = {}): Promise<Reply> => {
  const response = await fetch(new URL(path, fake.url), { method, headers, body, redirect: 'manual' })
  return { status: response.status, headers: response.headers, body: await response.text() }
}

const parse = <T>(schema: z.ZodType<T>, reply: Reply) => schema.parse(JSON.parse(reply.body))

const tokensSchema = z.object({
  access_token: z.string(),
  refresh_token: z.string(),
  expires_in: z.number(),
  scope: z.string(),
})
const eventsSchema = z.object({
  items: z.array(z.object({ summary: z.string(), start: z.object({ dateTime: z.string().optional() }) })),
  nextPageToken: z.string().optional(),
})
const errorSchema = z.object({
  error: z.object({
    errors: z.array(z.object({ reason: z.string() })),
    details: z.array(z.object({ reason: z.string() })).optional(),
  }),
})

const callback = 'http://localhost:1424/oauth/callback'

const tokenRequest = (fields: Record<string, string>) =>
  call('/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: fakeGoogleClientId,
      client_secret: fakeGoogleClientSecret,
      ...fields,
    }).toString(),
  })

/** Picks `account` on the chooser and returns the code it redirects back with. */
const authorize = async (account: string) => {
  const params = new URLSearchParams({
    client_id: fakeGoogleClientId,
    redirect_uri: callback,
    response_type: 'code',
    scope,
    state: 's1',
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    account,
  })
  const reply = await call(`/o/oauth2/v2/auth?${params}`)
  expect(reply.status).toBe(302)
  const location = new URL(reply.headers.get('location') ?? '')
  expect(location.origin + location.pathname).toBe(callback)
  expect(location.searchParams.get('state')).toBe('s1')
  return location.searchParams.get('code') ?? ''
}

const exchange = async (account: string, overrides: Record<string, string> = {}) =>
  tokenRequest({
    grant_type: 'authorization_code',
    code: await authorize(account),
    redirect_uri: callback,
    code_verifier: verifier,
    ...overrides,
  })

const connect = async (account: string) => parse(tokensSchema, await exchange(account))

const get = (path: string, accessToken: string) => call(path, { headers: { Authorization: `Bearer ${accessToken}` } })

const events = (calendarId: string, accessToken: string) => {
  const now = Date.now()
  const window = `timeMin=${new Date(now).toISOString()}&timeMax=${new Date(now + 8 * 86_400_000).toISOString()}`
  return get(`/calendar/v3/calendars/${calendarId}/events?${window}&singleEvents=true&maxResults=50`, accessToken)
}

const thursday = (items: z.infer<typeof eventsSchema>['items']) =>
  items
    .filter((item) => item.start.dateTime && new Date(item.start.dateTime).getUTCDay() === 4)
    .map((item) => `${item.start.dateTime?.slice(11, 16)} ${item.summary}`)

describe('fake Google', () => {
  it('lists every account on the chooser', async () => {
    const params = new URLSearchParams({ client_id: fakeGoogleClientId, response_type: 'code', redirect_uri: callback })
    const chooser = await call(`/o/oauth2/v2/auth?${params}`)
    for (const name of 'jonas camille expired revoked no-calendar-api no-calendar-scope empty big'.split(' ')) {
      expect(chooser.body).toContain(`${name}@gmail.test`)
    }
  })

  it("serves both of Jonas's calendars by id, so only 11:00-12:00 is free in both on Thursday", async () => {
    const { access_token } = await connect('jonas@gmail.test')
    const primary = parse(eventsSchema, await events('primary', access_token))
    const work = parse(eventsSchema, await events('jonas%40northwind.test', access_token))

    expect(thursday(primary.items)).toEqual([
      '09:00 Client workshop (Acme)',
      '12:00 Lunch with Ana',
      '13:00 Proposal writing',
      '16:00 Quarterly planning',
    ])
    expect(primary.items.map((item) => item.summary)).toContain('Conference - Lisbon')
    expect(thursday(work.items)).toEqual(['15:00 Design review'])

    const unknown = await events('nobody%40example.test', access_token)
    expect(unknown.status).toBe(404)
    expect(parse(errorSchema, unknown).error.errors[0].reason).toBe('notFound')

    const user = parse(z.object({ email: z.string() }), await get('/oauth2/v2/userinfo', access_token))
    expect(user.email).toBe('jonas@gmail.test')
  })

  it("lists only Camille's 6 unread emails and accepts a draft", async () => {
    const { access_token } = await connect('camille@gmail.test')
    const list = z.object({ messages: z.array(z.object({ id: z.string() })), resultSizeEstimate: z.number() })
    const unread = parse(list, await get('/gmail/v1/users/me/messages?q=is%3Aunread', access_token))
    expect(unread.resultSizeEstimate).toBe(6)

    const headers = z.object({
      payload: z.object({ headers: z.array(z.object({ name: z.string(), value: z.string() })) }),
    })
    const metadata = `/gmail/v1/users/me/messages/${unread.messages[0].id}?format=metadata&metadataHeaders=From,Subject`
    expect(parse(headers, await get(metadata, access_token)).payload.headers).toEqual([
      { name: 'From', value: 'Rita Okafor <rita.okafor@northstar-ventures.test>' },
      { name: 'Subject', value: 'Term sheet: signature needed today by 17:00 UTC' },
    ])

    const threads = z.object({ threads: z.array(z.object({ id: z.string() })) })
    const inbox = await get('/gmail/v1/users/me/threads?labelIds=INBOX&maxResults=20', access_token)
    expect(parse(threads, inbox).threads).toHaveLength(8)
    const readOnly = await get('/gmail/v1/users/me/messages?q=is%3Aunread%20from%3Apaul%20outage', access_token)
    expect(JSON.parse(readOnly.body)).toEqual({ resultSizeEstimate: 0 })

    const draft = await call('/gmail/v1/users/me/drafts', {
      method: 'POST',
      headers: { Authorization: `Bearer ${access_token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: { raw: 'VG86IHJpdGE' } }),
    })
    expect(parse(z.object({ id: z.string() }), draft).id).toStartWith('r-')
  })

  it('fails calendar calls with the reason Google gives, while Gmail keeps working', async () => {
    const disabled = await connect('no-calendar-api@gmail.test')
    const disabledReply = await events('primary', disabled.access_token)
    expect(disabledReply.status).toBe(403)
    const { error } = parse(errorSchema, disabledReply)
    expect([error.errors[0].reason, error.details?.[0].reason]).toEqual(['accessNotConfigured', 'SERVICE_DISABLED'])
    expect((await get('/gmail/v1/users/me/threads?labelIds=INBOX', disabled.access_token)).status).toBe(200)

    const noScope = await connect('no-calendar-scope@gmail.test')
    expect(noScope.scope).not.toContain('calendar')
    const scopeReply = await events('primary', noScope.access_token)
    expect(scopeReply.status).toBe(403)
    expect(parse(errorSchema, scopeReply).error.errors[0].reason).toBe('insufficientPermissions')
  })

  it('makes expired@ refresh on every call and revoked@ fail to refresh', async () => {
    const expired = await connect('expired@gmail.test')
    expect(expired.expires_in).toBe(1)
    expect((await tokenRequest({ grant_type: 'refresh_token', refresh_token: expired.refresh_token })).status).toBe(200)

    const revoked = await connect('revoked@gmail.test')
    const refused = await tokenRequest({ grant_type: 'refresh_token', refresh_token: revoked.refresh_token })
    expect(refused.status).toBe(400)
    expect(JSON.parse(refused.body)).toEqual({
      error: 'invalid_grant',
      error_description: 'Token has been expired or revoked.',
    })
  })

  it('checks the client secret, PKCE and the bearer token', async () => {
    expect((await exchange('jonas@gmail.test', { client_secret: 'nope' })).status).toBe(401)
    const wrongVerifier = await exchange('jonas@gmail.test', { code_verifier: 'other' })
    expect(JSON.parse(wrongVerifier.body)).toMatchObject({ error: 'invalid_grant' })
    expect((await get('/gmail/v1/users/me/threads', 'not-a-token')).status).toBe(401)
  })

  it('pages past maxResults for big@ and answers CORS preflights', async () => {
    const { access_token } = await connect('big@gmail.test')
    const big = parse(eventsSchema, await events('primary', access_token))
    expect(big.items).toHaveLength(50)
    expect(big.nextPageToken).toBe('50')

    const preflight = await call('/gmail/v1/users/me/threads', {
      method: 'OPTIONS',
      headers: { Origin: 'http://localhost:1424', 'Access-Control-Request-Headers': 'authorization' },
    })
    expect(preflight.status).toBe(204)
    expect(preflight.headers.get('access-control-allow-origin')).toBe('*')
    expect(preflight.headers.get('access-control-allow-headers')).toBe('authorization')
  })
})
