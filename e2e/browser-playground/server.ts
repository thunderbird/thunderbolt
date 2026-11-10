/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { join } from 'node:path'

const assets = new Set([
  'index.html',
  'minesweeper.html',
  'sudoku.html',
  'interactions.html',
  'styles.css',
  'minesweeper.js',
  'sudoku.js',
  'interactions.js',
])

/** Serve only the playground's public assets on loopback, without an app login or backend. */
export const startPlayground = (port = 4174) =>
  Bun.serve({
    hostname: '127.0.0.1',
    port,
    fetch: (request) => {
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        return new Response('Method not allowed', { status: 405, headers: { Allow: 'GET, HEAD' } })
      }
      const path = new URL(request.url).pathname
      const name = path === '/' ? 'index.html' : path.slice(1)
      if (!assets.has(name)) {
        return new Response('Not found', { status: 404 })
      }
      return new Response(Bun.file(join(import.meta.dir, name)), {
        headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
      })
    },
  })

if (import.meta.main) {
  const server = startPlayground(Number(process.env.BROWSER_PLAYGROUND_PORT ?? 4174))
  process.stdout.write(`Browser playground: ${server.url}\n`)
}
