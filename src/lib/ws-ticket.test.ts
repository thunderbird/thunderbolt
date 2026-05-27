/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import '@/testing-library'

import { describe, expect, it } from 'bun:test'
import { createAuthenticatedClient } from './http'
import { fetchWsTicket } from './ws-ticket'

type FetchFn = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

const buildClient = (fetchFn: FetchFn) =>
  createAuthenticatedClient('https://cloud.test/v1', () => 'test-token', { fetch: fetchFn })

describe('fetchWsTicket', () => {
  it('POSTs to <prefix>/ws-ticket with the requested scope and returns the ticket', async () => {
    let observedUrl = ''
    let observedBody = ''
    const fetchFn: FetchFn = async (input) => {
      const req = input as Request
      observedUrl = req.url
      observedBody = await req.text()
      return new Response(JSON.stringify({ ticket: 'nonce-xyz', expiresAt: Date.now() + 30_000 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    const ticket = await fetchWsTicket('haystack', { httpClient: buildClient(fetchFn) })
    expect(ticket).toBe('nonce-xyz')
    expect(observedUrl).toBe('https://cloud.test/v1/ws-ticket')
    expect(JSON.parse(observedBody)).toEqual({ scope: 'haystack' })
  })

  it('propagates HTTP errors from the backend', async () => {
    const fetchFn: FetchFn = async () =>
      new Response(JSON.stringify({ error: 'Forbidden', code: 'ANONYMOUS_TICKET_FORBIDDEN' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' },
      })
    await expect(fetchWsTicket('haystack', { httpClient: buildClient(fetchFn) })).rejects.toThrow(/403/)
  })

  it('surfaces network failures', async () => {
    const fetchFn: FetchFn = async () => {
      throw new TypeError('network down')
    }
    await expect(fetchWsTicket('haystack', { httpClient: buildClient(fetchFn) })).rejects.toThrow('network down')
  })
})
