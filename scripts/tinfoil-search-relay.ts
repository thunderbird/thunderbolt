/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { Connect, Plugin, ProxyOptions } from 'vite'

export const tinfoilSearchRelayPath = '/_tinfoil/search'
const forwardedHeaders = new Set([
  'authorization',
  'accept',
  'content-type',
  'content-length',
  'ehbp-encapsulated-key',
  'mcp-session-id',
  'mcp-protocol-version',
  'x-tinfoil-tool-pii-check',
  'x-tinfoil-tool-injection-check',
])

/** Rejects cross-site use and unencrypted POSTs before the fixed-target relay sees a request. */
export const guardTinfoilSearchRelay: Connect.NextHandleFunction = (req, res, next) => {
  if (req.url?.split('?')[0] !== tinfoilSearchRelayPath) {
    return next()
  }
  const status =
    req.headers['sec-fetch-site'] === 'cross-site'
      ? 403
      : !['POST', 'GET', 'DELETE'].includes(req.method ?? '')
        ? 405
        : !req.headers.authorization
          ? 401
          : req.method === 'POST' && !req.headers['ehbp-encapsulated-key']
            ? 400
            : 0
  if (!status) {
    return next()
  }
  res.writeHead(status, { 'Cache-Control': 'no-store' })
  res.end()
}

/** Fixed upstream, header allowlist and streamed encrypted responses; never an arbitrary URL proxy. */
export const tinfoilSearchProxy: ProxyOptions = {
  target: 'https://websearch.tinfoil.sh',
  changeOrigin: true,
  secure: true,
  followRedirects: false,
  rewrite: () => '/mcp',
  proxyTimeout: 30_000,
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
}

/** Dev and preview match the production frontend's encrypted search relay. */
export const tinfoilSearchRelayPlugin = (): Plugin => ({
  name: 'tinfoil-search-relay',
  configureServer: (server) => {
    server.middlewares.use(guardTinfoilSearchRelay)
  },
  configurePreviewServer: (server) => {
    server.middlewares.use(guardTinfoilSearchRelay)
  },
})
