/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { expect, it } from 'bun:test'
import { fetch as bunFetch } from 'bun'
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { guardTinfoilSearchRelay, tinfoilSearchProxy } from './tinfoil-search-relay'

/** Runs the gate without sockets so rejected requests cannot reach the upstream. */
const guard = (method: string, headers: IncomingMessage['headers'], url = '/_tinfoil/search') => {
  const result = { status: 0, forwarded: false }
  const req = { url, method, headers } as IncomingMessage
  const res = {
    writeHead: (status: number) => {
      result.status = status
    },
    end: () => {},
  } as ServerResponse
  guardTinfoilSearchRelay(req, res, () => {
    result.forwarded = true
  })
  return result
}
it('requires authorization and encrypted POSTs, blocking cross-site access and unsupported methods', () => {
  expect(guard('POST', {})).toEqual({ status: 401, forwarded: false })
  expect(guard('POST', { authorization: 'Bearer fake' })).toEqual({ status: 400, forwarded: false })
  expect(
    guard('POST', { authorization: 'Bearer fake', 'ehbp-encapsulated-key': 'key', 'sec-fetch-site': 'cross-site' }),
  ).toEqual({ status: 403, forwarded: false })
  expect(guard('PUT', { authorization: 'Bearer fake' })).toEqual({ status: 405, forwarded: false })
  expect(
    guard('POST', { authorization: 'Bearer fake', 'ehbp-encapsulated-key': 'key', 'sec-fetch-site': 'same-origin' }),
  ).toEqual({ status: 0, forwarded: true })
  expect(guard('GET', { authorization: 'Bearer fake' })).toEqual({ status: 0, forwarded: true })
})
it('has a fixed TLS upstream and never follows redirects or forwards query parameters', () => {
  expect(tinfoilSearchProxy.target).toBe('https://websearch.tinfoil.sh')
  expect(tinfoilSearchProxy.secure).toBe(true)
  expect(tinfoilSearchProxy.followRedirects).toBe(false)
  expect(tinfoilSearchProxy.rewrite?.('/_tinfoil/search?target=https://other.example')).toBe('/mcp')
})

it('relays opaque bytes and streams responses without forwarding browser or app credentials', async () => {
  const { createServer } = await import('vite')
  const { tinfoilSearchRelayPlugin } = await import('./tinfoil-search-relay')
  const upstream = createHttpServer(async (request, response) => {
    expect(request.url).toBe('/mcp')
    expect(request.headers.authorization).toBe('Bearer provider-test')
    expect(request.headers['ehbp-encapsulated-key']).toBe('test-envelope')
    expect(request.headers['x-tinfoil-tool-pii-check']).toBe('true')
    expect(request.headers.origin).toBeUndefined()
    expect(request.headers.cookie).toBeUndefined()
    expect(request.headers['sec-fetch-site']).toBeUndefined()
    expect(request.headers['x-app-version']).toBeUndefined()
    const chunks: Buffer[] = []
    for await (const chunk of request) {
      chunks.push(Buffer.from(chunk))
    }
    expect(Buffer.concat(chunks).toString()).toBe('opaque-encrypted-body')
    response.writeHead(200, {
      'ehbp-response-nonce': 'test-nonce',
      'set-cookie': 'do-not-forward=1',
      'content-type': 'text/event-stream',
    })
    response.write('opaque-encrypted-')
    response.end('response')
  })
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve))
  const upstreamAddress = upstream.address()
  if (!upstreamAddress || typeof upstreamAddress === 'string') {
    throw new Error('Expected TCP upstream')
  }
  const server = await createServer({
    configFile: false,
    root: '/tmp',
    appType: 'custom',
    logLevel: 'silent',
    plugins: [tinfoilSearchRelayPlugin()],
    server: {
      host: '127.0.0.1',
      port: 0,
      proxy: {
        '^/_tinfoil/search(?:\\?|$)': { ...tinfoilSearchProxy, target: `http://127.0.0.1:${upstreamAddress.port}` },
      },
    },
  })
  try {
    await server.listen()
    const address = server.httpServer!.address()
    if (!address || typeof address === 'string') {
      throw new Error('Expected TCP server')
    }
    const response = await bunFetch(`http://127.0.0.1:${address.port}/_tinfoil/search?target=discarded`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer provider-test',
        'ehbp-encapsulated-key': 'test-envelope',
        'x-tinfoil-tool-pii-check': 'true',
        origin: 'http://localhost',
        cookie: 'app-session=private',
        'sec-fetch-site': 'same-origin',
        'x-app-version': 'private-version',
      },
      body: 'opaque-encrypted-body',
    })
    expect(response.status).toBe(200)
    expect(response.headers.get('ehbp-response-nonce')).toBe('test-nonce')
    expect(response.headers.get('content-type')).toBe('text/event-stream')
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(response.headers.get('set-cookie')).toBeNull()
    expect(await response.text()).toBe('opaque-encrypted-response')
  } finally {
    await server.close()
    upstream.closeAllConnections()
    await new Promise<void>((resolve) => upstream.close(() => resolve()))
  }
})
