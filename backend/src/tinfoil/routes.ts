/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { Auth } from '@/auth/elysia-plugin'
import { createAuthMacro } from '@/auth/elysia-plugin'
import { getSettings } from '@/config/settings'
import { safeErrorHandler } from '@/middleware/error-handling'
import { Elysia, type AnyElysia } from 'elysia'

const allowedMethods = new Set(['GET', 'POST', 'OPTIONS'])
const bodylessMethods = new Set(['GET', 'OPTIONS'])

const textResponse = (status: number, body: string): Response =>
  new Response(body, { status, headers: { 'Content-Type': 'text/plain' } })

/** Forwards HPKE-encrypted bodies to the Tinfoil enclave; injects the bearer key from env. */
export type CreateTinfoilRoutesOptions = {
  auth: Auth
  fetchFn?: typeof fetch
  rateLimit?: AnyElysia
}

export const createTinfoilRoutes = (options: CreateTinfoilRoutesOptions) => {
  const { auth, rateLimit } = options
  const fetchFn = options.fetchFn ?? globalThis.fetch
  const settings = getSettings()

  return new Elysia({ prefix: '/tinfoil' })
    .onError(safeErrorHandler)
    .use(createAuthMacro(auth))
    .guard({ auth: true }, (g) => {
      if (rateLimit) {
        g.use(rateLimit)
      }

      return g.all('/*', async (ctx) => {
        const method = ctx.request.method.toUpperCase()

        if (!allowedMethods.has(method)) {
          return textResponse(405, 'Method not allowed')
        }

        if (!settings.tinfoilApiKey) {
          return textResponse(503, 'Tinfoil provider not configured')
        }

        const requestUrl = new URL(ctx.request.url)
        const path = requestUrl.pathname.replace(/^\/v1\/tinfoil/, '')
        const upstreamUrl = `${settings.tinfoilEnclaveUrl.replace(/\/$/, '')}${path}${requestUrl.search}`

        const headers = new Headers()
        ctx.request.headers.forEach((value, key) => {
          const lower = key.toLowerCase()
          if (lower === 'authorization' || lower === 'host' || lower === 'cookie' || lower === 'connection') {
            return
          }
          headers.set(key, value)
        })
        headers.set('Authorization', `Bearer ${settings.tinfoilApiKey}`)

        const body = bodylessMethods.has(method) ? null : ctx.request.body

        // Bun-specific fetch options: `duplex: 'half'` enables streaming request
        // bodies; `decompress: false` keeps the HPKE-encrypted bytes opaque on
        // the response path so the frontend SDK can decrypt them as-is.
        const upstream = await fetchFn(upstreamUrl, {
          method,
          headers,
          body,
          redirect: 'manual',
          decompress: false,
          duplex: 'half',
        } as RequestInit & { decompress: boolean; duplex: 'half' })

        const responseHeaders = new Headers()
        upstream.headers.forEach((value, key) => {
          const lower = key.toLowerCase()
          if (lower === 'transfer-encoding' || lower === 'connection') {
            return
          }
          responseHeaders.set(key, value)
        })

        return new Response(upstream.body, {
          status: upstream.status,
          statusText: upstream.statusText,
          headers: responseHeaders,
        })
      })
    })
}
