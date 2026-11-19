/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { expect, mock, spyOn, test } from 'bun:test'
import worker, { handleContact, type Env } from './index'

const origin = 'https://www.thunderbolt.io'
const endpoint = 'https://contact.example.com/api/contact'
/** Mirror the browser request, including Cloudflare's edge-supplied address. */
const submission = (fields: Record<string, unknown> = { email: 'person@example.org', website: '' }) =>
  new Request(endpoint, {
    method: 'POST',
    headers: {
      Origin: origin,
      'Content-Type': 'application/json',
      'CF-Connecting-IP': '192.0.2.1',
    },
    body: JSON.stringify(fields),
  })
/** Isolate bindings and mock the mail provider so no test sends real email. */
const setup = () => {
  const consume = mock(async (_url: RequestInfo | URL, _init?: RequestInit) => new Response(null, { status: 204 }))
  const env: Env = {
    ALLOWED_ORIGINS: `${origin}, https://thunderbolt.io`,
    RESEND_API_KEY: 're_test',
    EMAIL_FROM: 'website@example.com',
    CONTACT_EMAIL_TO: 'team@example.com',
    IP_LIMITER: { limit: mock(async () => ({ success: true })) },
    CONTACT_LIMITER: { getByName: mock(() => ({ fetch: consume })) },
  }
  const send = mock(async (_url: string, _init: RequestInit) => Response.json({ id: 'email-123' }))
  return { env, send, consume, run: (request = submission()) => handleContact(request, env, send) }
}

test('sends fixed notification with reply-to and acknowledges provider acceptance', async () => {
  const { run, send, env, consume } = setup()
  const response = await run(
    submission({
      email: ' person@example.org ',
      firstName: 'Sam',
      lastName: 'Lee',
      org: 'Example',
      title: 'Engineer',
      companySize: '1 to 50',
      help: '<script>Not HTML</script>\nA second line',
      website: '',
    }),
  )
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ success: true })
  expect(response.headers.get('Access-Control-Allow-Origin')).toBe(origin)
  expect(response.headers.get('Cache-Control')).toBe('no-store')
  const [url, options] = send.mock.calls[0]
  expect(url).toBe('https://api.resend.com/emails')
  expect(options.method).toBe('POST')
  expect(options.headers).toEqual({ Authorization: 'Bearer re_test', 'Content-Type': 'application/json' })
  expect(options.signal).toBeInstanceOf(AbortSignal)
  expect(JSON.parse(options.body as string)).toEqual({
    from: 'website@example.com',
    to: ['team@example.com'],
    reply_to: 'person@example.org',
    subject: 'Thunderbolt website inquiry',
    text: 'Email: person@example.org\nName: Sam Lee\nOrganization: Example\nJob title: Engineer\nCompany size: 1 to 50\n\nHow can we help?\n<script>Not HTML</script>\nA second line',
  })
  expect(env.IP_LIMITER.limit).toHaveBeenCalledWith({ key: '192.0.2.1' })
  expect(env.CONTACT_LIMITER.getByName).toHaveBeenCalledWith('contact')
  const hash = new Bun.CryptoHasher('sha256').update('192.0.2.1').digest('hex')
  expect(consume).toHaveBeenCalledWith('https://limiter/consume', {
    method: 'POST',
    headers: { 'X-Contact-IP-Hash': hash },
  })
})

test('optional fields can be omitted', async () => {
  const { run, send } = setup()
  expect((await run()).status).toBe(200)
  expect(JSON.parse(send.mock.calls[0][1].body as string).text).toContain('Not provided')
})

test.each([null, 'null', '', 'https://evil.example', `${origin}.evil.example`])(
  'rejects origin %j before sending',
  async (value) => {
    const { run, send, env } = setup()
    const request = submission()
    if (value === null) request.headers.delete('Origin')
    else request.headers.set('Origin', value)
    const response = await run(request)
    expect(response.status).toBe(403)
    expect(response.headers.has('Access-Control-Allow-Origin')).toBe(false)
    expect(send).not.toHaveBeenCalled()
    expect(env.IP_LIMITER.limit).not.toHaveBeenCalled()
  },
)

test('allows configured apex origin', async () => {
  const { run } = setup()
  const request = submission()
  request.headers.set('Origin', 'https://thunderbolt.io')
  expect((await run(request)).headers.get('Access-Control-Allow-Origin')).toBe('https://thunderbolt.io')
})

test('preflight works without secrets, credentials or quota consumption', async () => {
  const { run, env, send } = setup()
  delete env.RESEND_API_KEY
  const response = await run(new Request(endpoint, { method: 'OPTIONS', headers: { Origin: origin } }))
  expect(response.status).toBe(204)
  expect(response.headers.get('Vary')).toBe('Origin')
  expect(response.headers.get('Access-Control-Allow-Methods')).toBe('POST, OPTIONS')
  expect(response.headers.get('Access-Control-Allow-Headers')).toBe('Content-Type')
  expect(response.headers.has('Access-Control-Allow-Credentials')).toBe(false)
  expect(send).not.toHaveBeenCalled()
  expect(env.IP_LIMITER.limit).not.toHaveBeenCalled()
})

test('rejects other routes and methods', async () => {
  const { run, send } = setup()
  expect((await run(new Request('https://contact.example.com/'))).status).toBe(404)
  const response = await run(new Request(endpoint, { headers: { Origin: origin } }))
  expect(response.status).toBe(405)
  expect(response.headers.get('Allow')).toBe('POST, OPTIONS')
  expect(send).not.toHaveBeenCalled()
})

test.each(['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data', ''])(
  'rejects content type %j',
  async (value) => {
    const { run, send } = setup()
    const request = submission()
    request.headers.set('Content-Type', value)
    expect((await run(request)).status).toBe(415)
    expect(send).not.toHaveBeenCalled()
  },
)

test('accepts JSON with charset', async () => {
  const { run } = setup()
  const request = submission()
  request.headers.set('Content-Type', 'application/json; charset=utf-8')
  expect((await run(request)).status).toBe(200)
})

test.each(['EMAIL_FROM', 'CONTACT_EMAIL_TO', 'RESEND_API_KEY'] as const)('fails closed without %s', async (key) => {
  const { run, env, send } = setup()
  delete env[key]
  expect((await run()).status).toBe(503)
  expect(send).not.toHaveBeenCalled()
})

test('rejects malformed configured inbox and missing trusted IP', async () => {
  const { run, env, send } = setup()
  env.CONTACT_EMAIL_TO = 'a@example.com,b@example.com'
  expect((await run()).status).toBe(503)
  env.CONTACT_EMAIL_TO = 'team@example.com'
  const request = submission()
  request.headers.delete('CF-Connecting-IP')
  request.headers.set('X-Forwarded-For', '192.0.2.2')
  expect((await run(request)).status).toBe(503)
  expect(send).not.toHaveBeenCalled()
})

test.each([
  {},
  { email: 'invalid' },
  { email: 'a@example.com\r\nBcc: b@example.com' },
  { email: 'a@example.com', to: 'attacker@example.com' },
  { email: 'a@example.com', website: 'https://bot.example' },
  { email: 'a@example.com', help: 'x'.repeat(5001) },
  { email: 'a@example.com', firstName: 'x'.repeat(151) },
  { email: 'a@example.com', lastName: 'x'.repeat(151) },
  { email: 'a@example.com', title: 'x'.repeat(151) },
  { email: 'a@example.com', org: 'x'.repeat(201) },
  { email: 'a@example.com', companySize: 'x'.repeat(51) },
  { email: 'a@example.com', help: 123 },
])('rejects invalid fields without consuming email budget', async (fields) => {
  const { run, send, env } = setup()
  expect((await run(submission(fields))).status).toBe(422)
  expect(send).not.toHaveBeenCalled()
  expect(env.CONTACT_LIMITER.getByName).not.toHaveBeenCalled()
})

test('stops delivery when the edge burst limit rejects', async () => {
  const { run, send, env } = setup()
  env.IP_LIMITER = { limit: mock(async () => ({ success: false })) }
  const response = await run()
  expect(response.status).toBe(429)
  expect(response.headers.get('Retry-After')).toBe('60')
  expect(response.headers.get('Access-Control-Allow-Origin')).toBe(origin)
  expect(send).not.toHaveBeenCalled()
})

test.each([400, 401, 403, 422, 429, 500])('rejects Resend HTTP %s without exposing diagnostics', async (status) => {
  const { run, send } = setup()
  send.mockImplementation(async () => new Response('Sensitive provider details', { status }))
  const log = spyOn(console, 'error').mockImplementation(() => {})
  try {
    const response = await run()
    expect(response.status).toBe(502)
    expect(await response.text()).not.toContain('Sensitive')
    expect(log.mock.calls).toEqual([['[contact] Resend did not acknowledge delivery; HTTP status:', status]])
  } finally {
    log.mockRestore()
  }
})

test.each([{}, { id: '' }, { error: 'bad request' }])('requires provider email ID: %j', async (body) => {
  const { run, send } = setup()
  send.mockImplementation(async () => Response.json(body))
  expect((await run()).status).toBe(502)
})

test('network and malformed provider responses stay failures', async () => {
  const { run, send } = setup()
  send.mockImplementation(async () => {
    throw new Error('Private details')
  })
  const response = await run()
  expect(response.status).toBe(502)
  expect(await response.text()).not.toContain('Private')
  send.mockImplementation(async () => new Response('not JSON'))
  expect((await run()).status).toBe(502)
})

test('binding failures cannot bypass throttling', async () => {
  const { run, env, send } = setup()
  env.IP_LIMITER.limit = async () => {
    throw new Error('Unavailable')
  }
  expect((await run()).status).toBe(502)
  expect(send).not.toHaveBeenCalled()
})

test('rejects malformed and oversized request bodies', async () => {
  const { run, send } = setup()
  const request = submission()
  request.headers.set('Content-Length', '32769')
  expect((await run(request)).status).toBe(413)
  expect((await run(new Request(endpoint, { method: 'POST', headers: submission().headers, body: '{' }))).status).toBe(
    400,
  )
  expect(send).not.toHaveBeenCalled()
})

test('the Worker entry point accepts the runtime context without using it as the mail sender', async () => {
  const { env } = setup()
  const context = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext
  const entry: ExportedHandler<Env> = worker
  const response = await entry.fetch!(
    new Request(endpoint, { method: 'OPTIONS', headers: { Origin: origin } }),
    env,
    context,
  )
  expect(response.status).toBe(204)
})

test('honors the shared hourly allowance and its retry time', async () => {
  const { run, send, consume } = setup()
  consume.mockImplementation(async () => new Response(null, { status: 429, headers: { 'Retry-After': '3540' } }))
  const response = await run()
  expect(response.status).toBe(429)
  expect(response.headers.get('Retry-After')).toBe('3540')
  expect(response.headers.get('Access-Control-Allow-Origin')).toBe(origin)
  expect(send).not.toHaveBeenCalled()
})

test('shared limiter failure never sends mail', async () => {
  const { run, send, consume } = setup()
  consume.mockImplementation(async () => new Response(null, { status: 500 }))
  expect((await run()).status).toBe(502)
  consume.mockImplementation(async () => {
    throw new Error('Unavailable')
  })
  expect((await run()).status).toBe(502)
  expect(send).not.toHaveBeenCalled()
})
