/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { Connect, Plugin, ProxyOptions } from 'vite'
import { exaRelayEndpoints } from '../shared/exa-relay'

const forwardedHeaders = new Set([
  'authorization',
  'accept',
  'content-type',
  'content-length',
  'mcp-session-id',
  'mcp-protocol-version',
  'last-event-id',
])

/** Rejects unknown endpoints, cross-site requests and unsupported methods before proxying. */
export const guardExaRelay: Connect.NextHandleFunction = (req, res, next) => {
  const path = req.url?.split('?')[0] ?? ''
  if (!path.startsWith('/_exa/')) {
    return next()
  }
  const endpoint = exaRelayEndpoints[path]
  const status = !endpoint
    ? 404
    : req.headers['sec-fetch-site'] === 'cross-site'
      ? 403
      : !endpoint.methods.includes(req.method ?? '')
        ? 405
        : 0
  if (!status) {
    return next()
  }
  res.writeHead(status, { 'Cache-Control': 'no-store' })
  res.end()
}

/** Every proxy has a fixed TLS destination and strips cookies, app headers, and upstream cookies. */
export const exaRelayProxies: Record<string, ProxyOptions> = Object.fromEntries(
  Object.entries(exaRelayEndpoints).map(([path, endpoint]) => [
    `^${path}(?:\\?|$)`,
    {
      target: new URL(endpoint.url).origin,
      changeOrigin: true,
      secure: true,
      followRedirects: false,
      rewrite: (requestPath: string) =>
        `${new URL(endpoint.url).pathname}${new URL(requestPath, 'http://localhost').search}`,
      proxyTimeout: 60_000,
      configure: (proxy) => {
        proxy.on('proxyReq', (outgoing) => {
          for (const name of outgoing.getHeaderNames()) {
            if (name !== 'host' && !forwardedHeaders.has(name)) {
              outgoing.removeHeader(name)
            }
          }
        })
        proxy.on('proxyRes', (incoming) => {
          delete incoming.headers['set-cookie']
          incoming.headers['cache-control'] = 'no-store'
        })
      },
    } satisfies ProxyOptions,
  ]),
)

/** Dev and production use the same narrow Exa relay contract. */
export const exaRelayPlugin = (): Plugin => ({
  name: 'exa-relay',
  configureServer: (server) => {
    server.middlewares.use(guardExaRelay)
  },
  configurePreviewServer: (server) => {
    server.middlewares.use(guardExaRelay)
  },
})
