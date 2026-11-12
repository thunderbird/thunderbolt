/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { renderHook } from '@testing-library/react'
import type { ReactNode } from 'react'
import { createAuthenticatedClient, createStandaloneClient } from '@/lib/http'
import { HttpClientProvider, useHttpClient } from './http-client-context'

describe('HttpClientProvider', () => {
  it('updates clients already captured by chat sessions when a server is connected or disconnected', async () => {
    const requests: Request[] = []
    const offlineClient = createStandaloneClient()
    const connectedClient = createAuthenticatedClient('https://chosen.example.com/v1', () => 'server-token', {
      fetch: async (input) => {
        requests.push(input as Request)
        return Response.json({ connected: true })
      },
    })
    let currentClient = offlineClient
    const wrapper = ({ children }: { children: ReactNode }) => (
      <HttpClientProvider httpClient={currentClient}>{children}</HttpClientProvider>
    )
    const { result, rerender } = renderHook(() => useHttpClient(), { wrapper })
    const capturedClient = result.current
    await expect(capturedClient.get('tools/search')).rejects.toThrow('Connect to a Thunderbolt server')

    currentClient = connectedClient
    rerender()
    expect(result.current).toBe(capturedClient)
    expect(await capturedClient.get('tools/search').json<{ connected: boolean }>()).toEqual({ connected: true })
    await capturedClient.post('tools/search', { json: { query: 'local setup' } })
    await capturedClient.delete('tools/search')
    expect(requests.map((request) => request.method)).toEqual(['GET', 'POST', 'DELETE'])
    expect(requests.every((request) => request.url === 'https://chosen.example.com/v1/tools/search')).toBe(true)
    expect(requests.every((request) => request.headers.get('Authorization') === 'Bearer server-token')).toBe(true)
    expect(await requests[1].json()).toEqual({ query: 'local setup' })

    currentClient = offlineClient
    rerender()
    await expect(capturedClient.post('tools/search')).rejects.toThrow('Connect to a Thunderbolt server')
    expect(requests).toHaveLength(3)
  })
})
