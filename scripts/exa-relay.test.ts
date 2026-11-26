/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { expect, it } from 'bun:test'
import { fetch as bunFetch } from 'bun'
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { guardExaRelay, exaRelayProxies } from './exa-relay'
import { exaBrowserRelayUrl, exaRelayEndpoints } from '../shared/exa-relay'

/** Runs rejection paths without allowing an upstream request. */
const guard = (url: string, method = 'GET', headers: IncomingMessage['headers'] = {}) => {
  const result = { status: 0, forwarded: false }
  guardExaRelay(
    { url, method, headers } as IncomingMessage,
    {
      writeHead: (status: number) => {
        result.status = status
      },
      end: () => {},
    } as ServerResponse,
    () => {
      result.forwarded = true
    },
  )
  return result
}

it('only accepts known endpoints and their supported methods from the app', () => {
  expect(guard('/_exa/unknown')).toEqual({ status: 404, forwarded: false })
  expect(guard('/_exa/register')).toEqual({ status: 405, forwarded: false })
  expect(guard('/_exa/token', 'POST', { 'sec-fetch-site': 'cross-site' })).toEqual({ status: 403, forwarded: false })
  expect(guard('/chats/new')).toEqual({ status: 0, forwarded: true })
  for (const [path, endpoint] of Object.entries(exaRelayEndpoints)) {
    for (const method of endpoint.methods) {
      expect(guard(path + '?session=test', method)).toEqual({ status: 0, forwarded: true })
    }
  }
})

it('maps exact Exa endpoints to fixed TLS targets without changing issuer or resource identity', () => {
  for (const [path, endpoint] of Object.entries(exaRelayEndpoints)) {
    const url = new URL(endpoint.url)
    expect(exaBrowserRelayUrl(url)).toBe(path)
    const proxy = exaRelayProxies[`^${path}(?:\\?|$)`]
    expect(proxy.target).toBe(url.origin)
    expect(proxy.secure).toBe(true)
    expect(proxy.followRedirects).toBe(false)
    expect(proxy.rewrite?.(path + '?session=test')).toBe(url.pathname + '?session=test')
  }
  expect(exaBrowserRelayUrl(new URL('https://auth.exa.ai.attacker.example/api/oauth/token'))).toBeUndefined()
  expect(exaBrowserRelayUrl(new URL('https://auth.exa.ai/arbitrary'))).toBeUndefined()
  expect(exaBrowserRelayUrl(new URL('http://auth.exa.ai/api/oauth/token'))).toBeUndefined()
})

it('relays MCP requests without forwarding browser cookies or app headers', async () => {
  const { createServer } = await import('vite')
  const { exaRelayPlugin } = await import('./exa-relay')
  const upstream = createHttpServer(async (request, response) => {
    expect(request.url).toBe('/mcp/oauth?session=test')
    expect(request.headers.authorization).toBe('Bearer provider-test')
    expect(request.headers['mcp-protocol-version']).toBe('2025-03-26')
    expect(request.headers['mcp-session-id']).toBe('test-session')
    expect(request.headers.origin).toBeUndefined()
    expect(request.headers.cookie).toBeUndefined()
    expect(request.headers['sec-fetch-site']).toBeUndefined()
    expect(request.headers['x-app-version']).toBeUndefined()
    const chunks: Buffer[] = []
    for await (const chunk of request) {
      chunks.push(Buffer.from(chunk))
    }
    expect(Buffer.concat(chunks).toString()).toBe('test-request-body')
    response.writeHead(200, {
      'mcp-session-id': 'response-session',
      'set-cookie': 'do-not-forward=1',
      'content-type': 'text/event-stream',
    })
    response.write('test-')
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
    plugins: [exaRelayPlugin()],
    server: {
      host: '127.0.0.1',
      port: 0,
      proxy: {
        '^/_exa/mcp(?:\\?|$)': {
          ...exaRelayProxies['^/_exa/mcp(?:\\?|$)'],
          target: `http://127.0.0.1:${upstreamAddress.port}`,
        },
      },
    },
  })
  try {
    await server.listen()
    const address = server.httpServer!.address()
    if (!address || typeof address === 'string') {
      throw new Error('Expected TCP server')
    }
    const response = await bunFetch(`http://127.0.0.1:${address.port}/_exa/mcp?session=test`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer provider-test',
        'mcp-protocol-version': '2025-03-26',
        'mcp-session-id': 'test-session',
        origin: 'http://localhost',
        cookie: 'app-session=private',
        'sec-fetch-site': 'same-origin',
        'x-app-version': 'private-version',
      },
      body: 'test-request-body',
    })
    expect(response.status).toBe(200)
    expect(response.headers.get('mcp-session-id')).toBe('response-session')
    expect(response.headers.get('content-type')).toBe('text/event-stream')
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(response.headers.get('set-cookie')).toBeNull()
    expect(await response.text()).toBe('test-response')
  } finally {
    await server.close()
    upstream.closeAllConnections()
    await new Promise<void>((resolve) => upstream.close(() => resolve()))
  }
})
