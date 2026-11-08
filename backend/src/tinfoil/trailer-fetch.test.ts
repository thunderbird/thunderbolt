/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { z } from 'zod'
import { fetchWithTrailers } from './trailer-fetch'

const usageReport = 'prompt=7,completion=3,total=10'

/** Read a request body to completion. */
const readBody = async (request: IncomingMessage): Promise<string> => {
  const chunks: Buffer[] = []
  for await (const chunk of request) {
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString()
}

type Handler = (request: IncomingMessage, response: ServerResponse) => void | Promise<void>

const routes = new Map<string, Handler>([
  [
    '/echo',
    async (request, response) => {
      const body = await readBody(request)
      response.writeHead(200, 'Fine', { 'Content-Type': 'text/plain', Trailer: 'X-Tinfoil-Usage-Metrics' })
      response.write(`${request.method} ${request.headers['x-probe']} ${body}`)
      response.addTrailers({ 'X-Tinfoil-Usage-Metrics': usageReport })
      response.end()
    },
  ],
  [
    '/redirect',
    (_request, response) => {
      response.writeHead(302, { Location: '/echo' })
      response.end()
    },
  ],
  [
    '/encoded',
    (_request, response) => {
      response.writeHead(200, { 'Content-Encoding': 'gzip' })
      response.end(Buffer.from([0x1f, 0x8b, 0x00]))
    },
  ],
  [
    '/no-content',
    (_request, response) => {
      response.writeHead(204)
      response.end()
    },
  ],
  [
    '/endless',
    (_request, response) => {
      response.writeHead(200, { Trailer: 'X-Tinfoil-Usage-Metrics' })
      response.write('first chunk')
    },
  ],
  ['/hang', () => {}],
])

describe('fetchWithTrailers', () => {
  let server: Server
  let origin: string

  beforeAll(async () => {
    server = createServer((request, response) => routes.get(request.url ?? '')?.(request, response))
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    origin = `http://127.0.0.1:${z.object({ port: z.number() }).parse(server.address()).port}`
  })

  afterAll(() => {
    server.closeAllConnections()
    server.close()
  })

  it('streams the request body and resolves the trailers once the response body ends', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('sealed-'))
        controller.enqueue(new TextEncoder().encode('bytes'))
        controller.close()
      },
    })

    const response = await fetchWithTrailers(`${origin}/echo`, {
      method: 'POST',
      headers: new Headers({ 'X-Probe': 'kept' }),
      body,
      signal: new AbortController().signal,
    })

    expect(response.status).toBe(200)
    expect(response.statusText).toBe('Fine')
    expect(response.headers.get('content-type')).toBe('text/plain')
    expect(await response.text()).toBe('POST kept sealed-bytes')
    expect((await response.trailers)?.get('x-tinfoil-usage-metrics')).toBe(usageReport)
  })

  it('resolves null trailers when the body is cancelled before it ends', async () => {
    const response = await fetchWithTrailers(`${origin}/endless`, {
      method: 'GET',
      headers: {},
      signal: new AbortController().signal,
    })
    const reader = response.body!.getReader()
    await reader.read()
    await reader.cancel()

    expect(await response.trailers).toBeNull()
  })

  it('neither follows a redirect nor decodes the body', async () => {
    const signal = new AbortController().signal
    const redirect = await fetchWithTrailers(`${origin}/redirect`, { method: 'GET', headers: {}, signal })
    const encoded = await fetchWithTrailers(`${origin}/encoded`, { method: 'GET', headers: {}, signal })

    expect(redirect.status).toBe(302)
    expect(redirect.headers.get('location')).toBe('/echo')
    await redirect.arrayBuffer()
    expect(new Uint8Array(await encoded.arrayBuffer())).toEqual(new Uint8Array([0x1f, 0x8b, 0x00]))
  })

  it('returns a null body for a no-content status and still settles the trailers', async () => {
    const response = await fetchWithTrailers(`${origin}/no-content`, {
      method: 'GET',
      headers: {},
      signal: new AbortController().signal,
    })

    expect(response.status).toBe(204)
    expect(response.body).toBeNull()
    expect(await response.trailers).not.toBeUndefined()
  })

  it('rejects with the abort reason when aborted before the response headers', async () => {
    const controller = new AbortController()
    const reason = new DOMException('headers timeout', 'TimeoutError')
    const pending = fetchWithTrailers(`${origin}/hang`, { method: 'GET', headers: {}, signal: controller.signal })

    controller.abort(reason)

    await expect(pending).rejects.toBe(reason)
  })
})
