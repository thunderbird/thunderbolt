/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { saveIntegrationCredentials } from '@/dal/integrations'
import { setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { getDb } from '@/db/database'
import { createAuthenticatedClient } from '@/lib/http'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { createConfigs, getMessage, listMessages } from './tools'

/** Synthetic messages with the fields returned by the HTML body projection. */
const makeMessage = (id: string) => ({
  id,
  subject: `Subject ${id}`,
  bodyPreview: `Preview ${id}`,
  body: { contentType: 'HTML' as const, content: `<p>Body <strong>${id}</strong></p>` },
  from: { emailAddress: { address: 'sender@example.invalid' } },
  toRecipients: [{ emailAddress: { address: 'recipient@example.invalid' } }],
  receivedDateTime: '2026-01-01T00:00:00Z',
})

/** Fake Graph transport behind the app's authenticated HTTP client. */
const createGraphClient = (messages: ReturnType<typeof makeMessage>[]) => {
  const requests: Request[] = []
  const nextLink = 'https://graph.microsoft.com/v1.0/me/messages?$skiptoken=opaque%2Bpage'
  const page = { value: messages, '@odata.nextLink': nextLink, '@odata.context': 'synthetic-context' }
  const client = createAuthenticatedClient('https://backend.example.invalid/v1', () => 'synthetic-app-token', {
    fetch: async (input) => {
      const request = input as Request
      requests.push(request)
      expect(request.headers.get('Authorization')).toBe('Bearer synthetic-graph-token')
      const url = new URL(request.url)
      const data =
        url.pathname === '/v1.0/me/messages' ? page : messages.find((msg) => url.pathname.endsWith(`/${msg.id}`))
      return Response.json(data)
    },
  })
  return { client, requests, page }
}

describe('Microsoft message tools', () => {
  beforeAll(async () => {
    await setupTestDatabase()
    await saveIntegrationCredentials(
      getDb(),
      'microsoft',
      { access_token: 'synthetic-graph-token', expires_at: Date.now() + 3600_000 },
      true,
    )
  })

  afterAll(teardownTestDatabase)

  it('returns 300 HTML messages with one authenticated Graph request', async () => {
    const messages = Array.from({ length: 300 }, (_, i) => makeMessage(`message-${i}`))
    const { client, requests, page } = createGraphClient(messages)
    const tool = createConfigs(client).find((config) => config.name === 'microsoft_list_messages')!

    const result = await tool.execute({ top: 300, skipToken: '', filter: '', includeBodyHtml: true })

    expect(result).toEqual(page)
    expect(requests).toHaveLength(1)
    expect(new URL(requests[0].url).searchParams.get('$select')).toBe(
      'id,subject,body,bodyPreview,from,toRecipients,receivedDateTime',
    )
  })

  it('leaves the no-body list request and page metadata unchanged', async () => {
    const { client, requests, page } = createGraphClient(
      Array.from({ length: 300 }, (_, i) => makeMessage(`message-${i}`)),
    )

    expect(await listMessages({ top: 300, skipToken: '', filter: '', includeBodyHtml: false }, client)).toEqual(page)
    expect(requests).toHaveLength(1)
    expect(new URL(requests[0].url).searchParams.has('$select')).toBe(false)
  })

  it('preserves HTML, page order, metadata and paging/filter inputs', async () => {
    const { client, requests, page } = createGraphClient([makeMessage('second'), makeMessage('first')])

    const result = await listMessages(
      { top: 2, skipToken: 'opaque+page/=', filter: "subject eq 'Synthetic'", includeBodyHtml: true },
      client,
    )

    expect(result).toEqual(page)
    expect(requests).toHaveLength(1)
    const query = new URL(requests[0].url).searchParams
    expect(query.get('$top')).toBe('2')
    expect(query.get('$skiptoken')).toBe('opaque+page/=')
    expect(query.get('$filter')).toBe("subject eq 'Synthetic'")
  })

  it('returns an empty page without follow-up requests', async () => {
    const { client, requests, page } = createGraphClient([])
    expect(await listMessages({ top: 2, skipToken: '', filter: '', includeBodyHtml: true }, client)).toEqual(page)
    expect(requests).toHaveLength(1)
  })

  it.each([401, 429, 504])('propagates Graph HTTP %i errors', async (status) => {
    const client = createAuthenticatedClient('https://backend.example.invalid/v1', () => 'synthetic-app-token', {
      fetch: async () => new Response(null, { status }),
    })

    await expect(listMessages({ top: 300, skipToken: '', filter: '', includeBodyHtml: true }, client)).rejects.toThrow(
      `Request failed with status ${status}`,
    )
  })

  it('still retrieves an individual HTML message', async () => {
    const message = makeMessage('individual')
    const { client, requests } = createGraphClient([message])
    expect(await getMessage({ id: 'individual', includeBodyHtml: true }, client)).toEqual(message)
    expect(requests).toHaveLength(1)
    expect(new URL(requests[0].url).pathname).toBe('/v1.0/me/messages/individual')
  })
})
