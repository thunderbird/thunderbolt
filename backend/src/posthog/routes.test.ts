/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { ConsoleSpies } from '@/test-utils/console-spies'
import { setupConsoleSpy } from '@/test-utils/console-spies'
import { createTestSettings } from '@/test-utils/settings'
import { afterAll, beforeAll, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test'
import { Elysia } from 'elysia'
import { createPostHogRoutes } from './routes'
import * as settingsModule from '@/config/settings'

describe('PostHog Proxy Routes', () => {
  let app: { handle: Elysia['handle'] }
  let getSettingsSpy: ReturnType<typeof spyOn>
  let consoleSpies: ConsoleSpies
  let mockFetch: ReturnType<typeof mock>

  beforeAll(() => {
    consoleSpies = setupConsoleSpy()

    getSettingsSpy = spyOn(settingsModule, 'getSettings').mockReturnValue(
      createTestSettings({ posthogApiKey: 'test-key' }),
    )

    mockFetch = mock(() =>
      Promise.resolve(new Response('{"status":1}', { status: 200, headers: { 'content-type': 'application/json' } })),
    )

    app = new Elysia().use(createPostHogRoutes(mockFetch as unknown as typeof fetch))
  })

  afterAll(() => {
    getSettingsSpy?.mockRestore()
    consoleSpies.restore()
  })

  beforeEach(() => {
    mockFetch.mockClear()
    consoleSpies.error.mockClear()
  })

  it('does not forward the browser Referer upstream', async () => {
    // A same-origin analytics request carries the full page URL here, so
    // forwarding it would leak query strings that before_send already scrubbed
    // out of the event body.
    await app.handle(
      new Request('http://localhost/posthog/e/', {
        method: 'POST',
        headers: {
          referer: 'https://app.test/auth-error?error_description=Client+not+registered',
          'content-type': 'application/json',
        },
        body: '{}',
      }),
    )

    const forwarded = new Headers((mockFetch.mock.calls[0][1] as RequestInit).headers as HeadersInit)
    // Positive control: the rest of the request headers still go through.
    expect(forwarded.get('content-type')).toBe('application/json')
    expect(forwarded.has('referer')).toBe(false)
  })

  it('adds security headers to prevent XSS via proxied content', async () => {
    mockFetch.mockImplementation(() =>
      Promise.resolve(
        new Response('<html><script>alert("xss")</script></html>', {
          status: 200,
          headers: { 'content-type': 'text/html' },
        }),
      ),
    )

    const response = await app.handle(new Request('http://localhost/posthog/some/path', { method: 'GET' }))

    expect(response.headers.get('content-security-policy')).toBe('sandbox')
    expect(response.headers.get('content-disposition')).toBe('attachment')
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
  })

  it('adds security headers for JSON responses too', async () => {
    mockFetch.mockImplementation(() =>
      Promise.resolve(new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } })),
    )

    const response = await app.handle(new Request('http://localhost/posthog/batch', { method: 'POST' }))

    expect(response.headers.get('content-security-policy')).toBe('sandbox')
    expect(response.headers.get('content-disposition')).toBe('attachment')
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
  })
})
