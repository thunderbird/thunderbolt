/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { NextConfig } from 'next'

/**
 * Origins allowed to embed this app.
 *
 * `1420` is Thunderbolt's Vite dev server (a Tauri convention, not Vite's usual
 * 5173). `tauri://localhost` and `http://tauri.localhost` are the desktop app's
 * origins on macOS and Windows respectively.
 */
const allowedEmbedders = ['http://localhost:1420', 'tauri://localhost', 'http://tauri.localhost']

/**
 * The two headers a Thunderbolt Mini App must send. Both fail the same way — a
 * blank panel, no console error in the embedding page — so they're worth getting
 * right before debugging anything else.
 *
 * 1. **`frame-ancestors`** — browsers refuse to render a frame whose CSP doesn't
 *    list the embedder, and Next.js sets no CSP by default. Without this the app
 *    works standalone and silently refuses to embed.
 *
 * 2. **`Cross-Origin-Embedder-Policy` + `Cross-Origin-Resource-Policy`** —
 *    Thunderbolt is *cross-origin isolated*: it sets COEP because PowerSync's
 *    wa-sqlite worker needs `SharedArrayBuffer`. A cross-origin iframe inside a
 *    COEP document has to opt in, or it is blocked. This is not a Thunderbolt
 *    quirk; it applies to embedding in any cross-origin-isolated host.
 */
const nextConfig: NextConfig = {
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          {
            key: 'Content-Security-Policy',
            value: `frame-ancestors 'self' ${allowedEmbedders.join(' ')};`,
          },
          { key: 'Cross-Origin-Embedder-Policy', value: 'credentialless' },
          { key: 'Cross-Origin-Resource-Policy', value: 'cross-origin' },
        ],
      },
    ]
  },
}

export default nextConfig
