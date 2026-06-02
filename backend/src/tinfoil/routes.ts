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
  /** Override the enclave bearer key. Defaults to `TINFOIL_API_KEY`. */
  apiKey?: string
  /** Override the upstream enclave URL. Defaults to `TINFOIL_ENCLAVE_URL`. */
  enclaveUrl?: string
}

export const createTinfoilRoutes = (options: CreateTinfoilRoutesOptions) => {
  const { auth, rateLimit } = options
  const fetchFn = options.fetchFn ?? globalThis.fetch
  const settings = getSettings()
  const apiKey = options.apiKey ?? settings.tinfoilApiKey
  const enclaveUrl = (options.enclaveUrl ?? settings.tinfoilEnclaveUrl).replace(/\/$/, '')

  const proxyToEnclave = async (request: Request, wildcard: string): Promise<Response> => {
    const method = request.method.toUpperCase()

    if (!allowedMethods.has(method)) {
      return textResponse(405, 'Method not allowed')
    }

    if (!apiKey) {
      return textResponse(503, 'Tinfoil provider not configured')
    }

    const subpath = wildcard.startsWith('/') ? wildcard : `/${wildcard}`
    const search = new URL(request.url).search
    const upstreamUrl = `${enclaveUrl}${subpath}${search}`

    const headers = new Headers()
    request.headers.forEach((value, key) => {
      const lower = key.toLowerCase()
      if (lower === 'authorization' || lower === 'host' || lower === 'cookie' || lower === 'connection') {
        return
      }
      headers.set(key, value)
    })
    headers.set('Authorization', `Bearer ${apiKey}`)

    const body = bodylessMethods.has(method) ? null : request.body

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
  }

  // `{ parse: 'none' }` keeps the request stream untouched so the HPKE-encrypted
  // payload reaches the upstream unchanged, even for recognised content types.
  // The wildcard-derived subpath survives changes to the outer mount prefix
  // (e.g. `/v1` in src/index.ts). Branching at `.all()` keeps each chain's
  // Elysia type concrete (a ternary `g` vs `g.use(...)` would union the types
  // and make `.all()` uncallable / fall back to `any`).
  return new Elysia({ prefix: '/tinfoil' })
    .onError(safeErrorHandler)
    .use(createAuthMacro(auth))
    .guard({ auth: true }, (g) => {
      if (rateLimit) {
        return g
          .use(rateLimit)
          .all('/*', (ctx) => proxyToEnclave(ctx.request, ctx.params['*'] ?? ''), { parse: 'none' })
      }
      return g.all('/*', (ctx) => proxyToEnclave(ctx.request, ctx.params['*'] ?? ''), { parse: 'none' })
    })
}
