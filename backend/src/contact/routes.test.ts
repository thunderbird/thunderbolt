/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterEach, beforeAll, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test'
import { Elysia } from 'elysia'
import { render } from 'react-email'
import { clearSettingsCache } from '@/config/settings'
import { rateLimits } from '@/db/rate-limit-schema'
import { createApp } from '@/index'
import { EmailDeliveryError, type SendEmailParams } from '@/lib/resend'
import { createAppVersionMiddleware } from '@/middleware/app-version'
import type { RateLimitConsumer } from '@/middleware/rate-limit'
import { getSharedIsolatedTestDb } from '@/test-utils/db'
import { createContactRoutes } from './routes'

const contactUrl = 'http://localhost/v1/contact'
const jsonHeaders = { 'content-type': 'application/json' }

/** An email sender that records what it was asked to send instead of sending it. */
const createEmailService = (isConfigured = true) => {
  const send = mock(async (_params: SendEmailParams): Promise<unknown> => ({ id: 'accepted' }))
  /** The HTML of the most recent email, as the provider would receive it. */
  const sentHtml = async () => {
    const [params] = send.mock.calls.at(-1) ?? []
    if (!params) {
      throw new Error('No email was sent')
    }
    return render(params.react)
  }
  return { emailService: { isConfigured: () => isConfigured, send }, send, sentHtml }
}

type SetupOptions = { recipient?: string; isConfigured?: boolean; emailBudget?: RateLimitConsumer | null }

/** The route behind the production prefix and app-version gate, with no rate limits unless a test adds one. */
const setup = ({ recipient = 'team@example.org', isConfigured, emailBudget = null }: SetupOptions = {}) => {
  const email = createEmailService(isConfigured)
  const app = new Elysia({ prefix: '/v1' }).use(createAppVersionMiddleware({ minAppVersion: '99.0.0' })).use(
    createContactRoutes({
      settings: { contactEmailTo: recipient },
      ipRateLimit: new Elysia(),
      emailBudget,
      emailService: email.emailService,
    }),
  )
  const postRaw = (body: string, headers: Record<string, string> = jsonHeaders) =>
    app.handle(new Request(contactUrl, { method: 'POST', headers, body }))
  const post = (body: unknown) => postRaw(JSON.stringify(body))
  return { ...email, app, post, postRaw }
}

describe('public contact endpoint', () => {
  it('sends a minimal inquiry to the configured inbox, with no app-version header', async () => {
    const { post, send } = setup()
    const response = await post({ email: ' visitor@example.org ' })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ success: true })
    expect(send).toHaveBeenCalledTimes(1)
    expect(send.mock.calls[0]?.[0]).toMatchObject({
      to: 'team@example.org',
      replyTo: 'visitor@example.org',
      subject: 'Thunderbolt website inquiry',
    })
  })

  it.each([null, 'text/plain', 'application/x-www-form-urlencoded', 'application/jsonp'])(
    'refuses a body that is not declared as JSON, without reading it: %j',
    async (contentType) => {
      const { app, send } = setup()
      const request = new Request(contactUrl, {
        method: 'POST',
        body: JSON.stringify({ email: 'visitor@example.org' }),
      })
      if (contentType === null) {
        request.headers.delete('content-type')
      } else {
        request.headers.set('content-type', contentType)
      }
      expect((await app.handle(request)).status).toBe(415)
      expect(request.bodyUsed).toBe(false)
      expect(send).not.toHaveBeenCalled()
    },
  )

  it('accepts a JSON content type in any case, with a charset', async () => {
    const { postRaw, send } = setup()
    const response = await postRaw(JSON.stringify({ email: 'visitor@example.org' }), {
      'content-type': 'Application/JSON; charset=UTF-8',
    })
    expect(response.status).toBe(200)
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('renders every field as escaped text and keeps the line breaks of a message', async () => {
    const { post, sentHtml } = setup()
    await post({
      email: 'visitor@example.org',
      firstName: '<script>name</script>',
      lastName: 'Last',
      title: '<b>CTO</b>',
      org: '<img src=x>',
      companySize: '1,001+',
      help: 'Hello\n<a href="https://evil.test">world</a>',
      website: '',
    })
    const html = await sentHtml()
    expect(html).toContain('&lt;script&gt;name&lt;/script&gt; Last')
    expect(html).toContain('&lt;img src=x&gt;')
    expect(html).toContain('&lt;b&gt;CTO&lt;/b&gt;')
    expect(html).toContain('1,001+')
    expect(html).toContain('Hello\n&lt;a href=')
    expect(html).not.toContain('<script>')
    expect(html).not.toContain('<a href=')
  })

  it('trims each field and marks the ones left empty as not provided', async () => {
    const { post, sentHtml } = setup()
    await post({ email: 'visitor@example.org', firstName: '  Ada  ', org: '   ', title: '', companySize: '' })
    const html = await sentHtml()
    expect(html).toContain('<dd>Ada</dd>')
    expect(html.match(/Not provided/g)).toHaveLength(4)
  })

  // Each case is wrapped so `it.each` passes an array body as one argument instead of spreading it.
  const invalidBodies: [unknown][] = [
    null,
    [],
    {},
    { email: 12 },
    { email: 'invalid' },
    { email: 'a@example.org\r\nBcc: other@example.org' },
    { email: 'Visitor <a@example.org>' },
    { email: 'a@example.org,b@example.org' },
    { email: `${'x'.repeat(243)}@example.org` },
    { email: 'a@example.org', firstName: 'x'.repeat(151) },
    { email: 'a@example.org', lastName: 'x'.repeat(151) },
    { email: 'a@example.org', title: 'x'.repeat(151) },
    { email: 'a@example.org', org: 'x'.repeat(201) },
    { email: 'a@example.org', help: 'x'.repeat(5001) },
    { email: 'a@example.org', companySize: 'x'.repeat(51) },
    { email: 'a@example.org', website: 'https://bot.test' },
    { email: 'a@example.org', to: 'attacker@example.org' },
  ].map((body) => [body])
  it.each(invalidBodies)('rejects an invalid submission without sending: %j', async (body) => {
    const { post, send } = setup()
    expect((await post(body)).status).toBe(422)
    expect(send).not.toHaveBeenCalled()
  })

  it.each([
    ['one-byte', 'x'],
    ['three-byte', '字'],
  ])('accepts every field at its maximum length in %s characters', async (_label, character) => {
    const { post } = setup()
    const response = await post({
      email: `${'x'.repeat(242)}@example.org`,
      firstName: character.repeat(150),
      lastName: character.repeat(150),
      title: character.repeat(150),
      org: character.repeat(200),
      help: character.repeat(5000),
      companySize: character.repeat(50),
    })
    expect(response.status).toBe(200)
  })

  it.each(['user@xn--e1afmkfd.xn--p1ai', 'user!tag@example.org'])(
    'accepts an address the browser email field accepts: %s',
    async (email) => {
      const { post } = setup()
      expect((await post({ email })).status).toBe(200)
    },
  )

  it.each(['{bad', ''])('rejects a body that is not JSON: %j', async (body) => {
    const { postRaw, send } = setup()
    expect((await postRaw(body)).status).toBe(400)
    expect(send).not.toHaveBeenCalled()
  })

  it.each([
    ['streamed', jsonHeaders],
    ['declared', { ...jsonHeaders, 'content-length': '40000' }],
  ])('rejects an oversized %s body', async (_label, headers) => {
    const { postRaw, send } = setup()
    const body = JSON.stringify({ email: 'a@example.org', help: 'x'.repeat(40_000) })
    expect((await postRaw(body, headers)).status).toBe(413)
    expect(send).not.toHaveBeenCalled()
  })

  it.each([{ recipient: '' }, { isConfigured: false }])('is unavailable when unconfigured: %j', async (options) => {
    const { post, send } = setup(options)
    expect((await post({ email: 'a@example.org' })).status).toBe(503)
    expect(send).not.toHaveBeenCalled()
  })

  describe('shared email budget', () => {
    it('is charged once, under one key, for each inquiry about to be sent', async () => {
      const emailBudget = mock<RateLimitConsumer>(async () => undefined)
      const { post, send } = setup({ emailBudget })
      expect((await post({ email: 'invalid' })).status).toBe(422)
      expect(emailBudget).not.toHaveBeenCalled()
      expect((await post({ email: 'a@example.org' })).status).toBe(200)
      expect(emailBudget).toHaveBeenCalledTimes(1)
      expect(emailBudget.mock.calls[0]?.[0]).toBe('all')
      expect(send).toHaveBeenCalledTimes(1)
    })

    it('is left alone while the form is unconfigured', async () => {
      const emailBudget = mock<RateLimitConsumer>(async () => undefined)
      const { post } = setup({ emailBudget, isConfigured: false })
      expect((await post({ email: 'a@example.org' })).status).toBe(503)
      expect(emailBudget).not.toHaveBeenCalled()
    })

    it('refuses with its own retry time once spent, without sending', async () => {
      const emailBudget: RateLimitConsumer = async (_key, set) => {
        set.headers['Retry-After'] = '120'
        return { error: 'Too many requests. Please try again later.' }
      }
      const { post, send } = setup({ emailBudget })
      const response = await post({ email: 'a@example.org' })
      expect(response.status).toBe(429)
      expect(response.headers.get('retry-after')).toBe('120')
      expect(await response.json()).toEqual({ error: 'Too many requests. Please try again later.' })
      expect(send).not.toHaveBeenCalled()
    })

    it('keeps its headers off an accepted response', async () => {
      const emailBudget: RateLimitConsumer = async (_key, set) => {
        set.headers['RateLimit-Limit'] = '30'
        return undefined
      }
      const { post } = setup({ emailBudget })
      const response = await post({ email: 'a@example.org' })
      expect(response.status).toBe(200)
      expect(response.headers.get('ratelimit-limit')).toBeNull()
    })
  })

  describe('delivery failures', () => {
    it('reports a provider rejection as 502 and logs its code and status, never its message', async () => {
      const { post, send } = setup()
      const log = spyOn(console, 'error').mockImplementation(() => {})
      send.mockRejectedValueOnce(
        new EmailDeliveryError({
          name: 'invalid_api_key',
          statusCode: 401,
          message: 'Key rejected for visitor@example.org',
        }),
      )
      try {
        const response = await post({ email: 'visitor@example.org' })
        expect(response.status).toBe(502)
        expect(await response.json()).toEqual({ error: 'Your message could not be sent. Please try again later.' })
        expect(log.mock.calls).toEqual([
          ['[contact] Email delivery failed', { providerCode: 'invalid_api_key', status: 401 }],
        ])
      } finally {
        log.mockRestore()
      }
    })

    it('lets an unexpected error surface as a server error with its cause logged', async () => {
      const { post, send } = setup()
      const log = spyOn(console, 'error').mockImplementation(() => {})
      send.mockRejectedValueOnce(new TypeError('template failed to render'))
      try {
        const response = await post({ email: 'visitor@example.org' })
        expect(response.status).toBe(500)
        expect(await response.json()).toEqual({ success: false, data: null, error: 'Internal Server Error' })
        expect(log.mock.calls[0]).toEqual(['[500] POST /v1/contact — template failed to render'])
      } finally {
        log.mockRestore()
      }
    })
  })
})

describe('contact endpoint through the app', () => {
  const envKeys = ['CONTACT_EMAIL_TO', 'TRUSTED_PROXY', 'MIN_APP_VERSION'] as const
  let savedEnv: Partial<Record<string, string>>
  let db: Awaited<ReturnType<typeof getSharedIsolatedTestDb>>['db']

  // The limiters commit their own transactions, so this suite cannot use createTestDb.
  beforeAll(async () => {
    db = (await getSharedIsolatedTestDb()).db
  })

  beforeEach(async () => {
    savedEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]))
    process.env.CONTACT_EMAIL_TO = 'team@example.org'
    process.env.TRUSTED_PROXY = 'cloudflare'
    process.env.MIN_APP_VERSION = '99.0.0'
    clearSettingsCache()
    await db.delete(rateLimits)
  })

  afterEach(() => {
    for (const key of envKeys) {
      if (savedEnv[key] === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = savedEnv[key]
      }
    }
    clearSettingsCache()
  })

  const createContactApp = async () => {
    const email = createEmailService()
    const app = await createApp({ database: db, contactEmailService: email.emailService })
    const post = (ip: string) =>
      app.handle(
        new Request(contactUrl, {
          method: 'POST',
          headers: { ...jsonHeaders, 'cf-connecting-ip': ip },
          body: JSON.stringify({ email: 'visitor@example.org' }),
        }),
      )
    return { ...email, app, post }
  }

  it('is served below the minimum app version and sends to the configured inbox', async () => {
    const { post, send } = await createContactApp()
    expect((await post('192.0.2.1')).status).toBe(200)
    expect(send.mock.calls[0]?.[0]).toMatchObject({ to: 'team@example.org', replyTo: 'visitor@example.org' })
  })

  // The test preload sets RATE_LIMIT_ENABLED=false, so both limits below are on despite it.
  it('allows each address three inquiries an hour and limits no other route', async () => {
    const { app, post, send } = await createContactApp()
    for (let count = 0; count < 3; count++) {
      const response = await post('192.0.2.1')
      expect(response.status).toBe(200)
      expect(response.headers.get('ratelimit-limit')).toBe('3')
    }
    const limited = await post('192.0.2.1')
    expect(limited.status).toBe(429)
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(3500)
    expect(send).toHaveBeenCalledTimes(3)

    const config = await app.handle(
      new Request('http://localhost/v1/config', { headers: { 'cf-connecting-ip': '192.0.2.1' } }),
    )
    expect(config.status).toBe(200)
    expect(config.headers.get('ratelimit-limit')).toBeNull()

    expect((await post('192.0.2.2')).status).toBe(200)
    expect(send).toHaveBeenCalledTimes(4)
  })

  it('stops sending once thirty inquiries have gone out in an hour, whatever the address', async () => {
    await db
      .insert(rateLimits)
      .values({ key: 'contact-global:all', points: 29, expire: new Date(Date.now() + 3_600_000) })
    const { post, send } = await createContactApp()
    expect((await post('192.0.2.1')).status).toBe(200)
    const limited = await post('192.0.2.2')
    expect(limited.status).toBe(429)
    expect(limited.headers.get('ratelimit-limit')).toBe('30')
    expect(send).toHaveBeenCalledTimes(1)
  })
})
