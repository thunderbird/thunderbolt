/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { createClient } from '@/lib/http'
import { getClock } from '@/testing-library'
import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test'
import { reportConnectionEvent } from './report-connection-event'

const event = {
  action: 'user_connection.added',
  target: { type: 'mcp_server', id: 'mcp-1' },
  authMethod: 'none',
} as const

describe('reportConnectionEvent', () => {
  afterEach(() => {
    mock.restore()
  })

  it('posts the event to the client audit route', async () => {
    const requests: { path: string; body: unknown }[] = []
    const client = createClient({
      prefixUrl: 'http://backend.test',
      fetch: async (input, init) => {
        const request = input instanceof Request ? input : new Request(input, init)
        requests.push({ path: new URL(request.url).pathname, body: await request.json() })
        return new Response(null, { status: 204 })
      },
    })

    reportConnectionEvent(client, event)
    await getClock().runAllAsync()

    expect(requests).toEqual([{ path: '/audit/client-events', body: event }])
  })

  it('drops a report that fails, with a warning and no throw', async () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {})
    const client = createClient({
      prefixUrl: 'http://backend.test',
      fetch: async () => {
        throw new TypeError('Failed to fetch')
      },
    })

    expect(() => reportConnectionEvent(client, event)).not.toThrow()
    await getClock().runAllAsync()

    expect(warn).toHaveBeenCalledTimes(1)
  })
})
