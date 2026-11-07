/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it, mock, spyOn } from 'bun:test'
import { Elysia } from 'elysia'
import { renderToStaticMarkup } from 'react-dom/server'
import { EmailDeliveryError, type SendEmailParams } from '@/lib/resend'
import { createAppVersionMiddleware } from '@/middleware/app-version'
import { createContactRoutes } from './routes'

/** Exercise the production prefix and app-version gate without sending email. */
const setup = ({
  recipient = 'team@example.org',
  configured = true,
}: { recipient?: string; configured?: boolean } = {}) => {
  const send = mock(async (_params: SendEmailParams): Promise<{ id: string }> => ({ id: 'accepted' }))
  const app = new Elysia({ prefix: '/v1' }).use(createAppVersionMiddleware({ minAppVersion: '99.0.0' })).use(
    createContactRoutes({
      settings: { contactEmailTo: recipient },
      ipRateLimit: new Elysia(),
      emailService: { isConfigured: () => configured, send },
    }),
  )
  const request = (body: unknown) =>
    app.handle(
      new Request('http://localhost/v1/contact', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
    )
  return { app, send, request }
}

describe('public contact endpoint', () => {
  it('accepts a minimal request without an app-version header, using only the configured inbox', async () => {
    const { request, send } = setup()
    const response = await request({ email: ' visitor@example.org ' })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ success: true })
    expect(send).toHaveBeenCalledTimes(1)
    expect(send.mock.calls[0]?.[0]).toMatchObject({
      to: 'team@example.org',
      replyTo: 'visitor@example.org',
      subject: 'Thunderbolt website inquiry',
    })
  })

  it('requires a JSON content type before reading a browser-simple request body', async () => {
    const { app, send } = setup()
    for (const contentType of [null, 'text/plain', 'application/x-www-form-urlencoded', 'application/jsonp']) {
      const request = new Request('http://localhost/v1/contact', {
        method: 'POST',
        body: JSON.stringify({ email: 'visitor@example.org' }),
      })
      if (contentType === null) {
        request.headers.delete('content-type')
      } else {
        request.headers.set('content-type', contentType)
      }
      const response = await app.handle(request)
      expect(response.status).toBe(415)
      expect(request.bodyUsed).toBe(false)
    }
    expect(send).not.toHaveBeenCalled()
  })

  it('accepts JSON with a charset and case-insensitive media type', async () => {
    const { app, send } = setup()
    const response = await app.handle(
      new Request('http://localhost/v1/contact', {
        method: 'POST',
        headers: { 'content-type': 'Application/JSON; charset=UTF-8' },
        body: JSON.stringify({ email: 'visitor@example.org' }),
      }),
    )
    expect(response.status).toBe(200)
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('renders every supplied field as escaped text, preserving multiline messages', async () => {
    const { request, send } = setup()
    await request({
      email: 'visitor@example.org',
      firstName: '<script>name</script>',
      lastName: 'Last',
      title: '<b>CTO</b>',
      org: '<img src=x>',
      companySize: '1,001+',
      help: 'Hello\n<a href="https://evil.test">world</a>',
      website: '',
    })
    const html = renderToStaticMarkup(send.mock.calls[0]![0].react)
    expect(html).toContain('&lt;script&gt;name&lt;/script&gt; Last')
    expect(html).toContain('&lt;img src=x&gt;')
    expect(html).toContain('&lt;b&gt;CTO&lt;/b&gt;')
    expect(html).toContain('1,001+')
    expect(html).toContain('Hello\n&lt;a href=')
    expect(html).not.toContain('<script>')
    expect(html).not.toContain('<a href=')
  })

  for (const body of [
    null,
    [],
    {},
    { email: 12 },
    { email: 'invalid' },
    { email: 'a@example.org\r\nBcc: other@example.org' },
    { email: `${'x'.repeat(243)}@example.org` },
    ...['firstName', 'lastName', 'title'].map((key) => ({ email: 'a@example.org', [key]: 'x'.repeat(151) })),
    { email: 'a@example.org', org: 'x'.repeat(201) },
    { email: 'a@example.org', help: 'x'.repeat(5001) },
    { email: 'a@example.org', companySize: 'huge' },
    { email: 'a@example.org', website: 'https://bot.test' },
    { email: 'a@example.org', to: 'attacker@example.org' },
  ]) {
    it(`rejects invalid fields without sending: ${JSON.stringify(body).slice(0, 90)}`, async () => {
      const { request, send } = setup()
      expect((await request(body)).status).toBe(422)
      expect(send).not.toHaveBeenCalled()
    })
  }

  it('accepts maximum-length fields and every company size', async () => {
    const { request, send } = setup()
    for (const companySize of ['', '1 to 50', '51 to 200', '201 to 1,000', '1,001+']) {
      const response = await request({
        email: `${'x'.repeat(242)}@example.org`,
        firstName: 'x'.repeat(150),
        lastName: 'x'.repeat(150),
        title: 'x'.repeat(150),
        org: 'x'.repeat(200),
        help: 'x'.repeat(5000),
        companySize,
      })
      expect(response.status).toBe(200)
    }
    expect(send).toHaveBeenCalledTimes(5)
  })

  it('rejects malformed JSON and empty bodies before sending', async () => {
    const { app, send } = setup()
    for (const body of ['{bad', '']) {
      const response = await app.handle(
        new Request('http://localhost/v1/contact', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body,
        }),
      )
      expect(response.status).toBe(400)
    }
    expect(send).not.toHaveBeenCalled()
  })

  it('rejects oversized declared and streamed bodies before sending', async () => {
    const { app, send } = setup()
    for (const headers of [
      new Headers({ 'content-type': 'application/json' }),
      new Headers({ 'content-type': 'application/json', 'content-length': '20000' }),
    ]) {
      const response = await app.handle(
        new Request('http://localhost/v1/contact', {
          method: 'POST',
          headers,
          body: JSON.stringify({ email: 'a@example.org', help: 'x'.repeat(20000) }),
        }),
      )
      expect(response.status).toBe(413)
    }
    expect(send).not.toHaveBeenCalled()
  })

  for (const options of [{ recipient: '' }, { configured: false }]) {
    it(`fails closed when unconfigured: ${JSON.stringify(options)}`, async () => {
      const { request, send } = setup(options)
      expect((await request({ email: 'a@example.org' })).status).toBe(503)
      expect(send).not.toHaveBeenCalled()
    })
  }

  it('logs structured delivery failures without logging addresses or credentials', async () => {
    const { request, send } = setup()
    const log = spyOn(console, 'error').mockImplementation(() => {})
    send.mockRejectedValueOnce(new EmailDeliveryError('invalid_api_key', 401))
    send.mockRejectedValueOnce(new Error('Secret provider credentials and visitor email'))
    send.mockResolvedValueOnce({ id: '' })
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        const response = await request({ email: 'a@example.org' })
        expect(response.status).toBe(502)
        expect(await response.json()).toEqual({ error: 'Your message could not be sent. Please try again later.' })
      }
      expect(log.mock.calls).toEqual([
        ['[contact] Email delivery failed', { providerCode: 'invalid_api_key', status: 401 }],
        ['[contact] Email delivery failed', { reason: 'provider_request_failed' }],
        ['[contact] Email delivery failed', { reason: 'missing_acceptance' }],
      ])
    } finally {
      log.mockRestore()
    }
  })
})
