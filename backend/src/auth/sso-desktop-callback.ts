/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { randomBytes } from 'crypto'
import { getSettings } from '@/config/settings'
import { safeErrorHandler } from '@/middleware/error-handling'
import { Elysia, t } from 'elysia'

const SESSION_COOKIE_NAME = 'better-auth.session_token'
const NONCE_COOKIE_NAME = 'thunderbolt_desktop_sso_nonce'

/** Allowed loopback ports — must match OAUTH_PORTS in src-tauri/src/commands.rs */
const ALLOWED_LOOPBACK_PORTS = new Set([17421, 17422, 17423])

/** Parse a specific cookie value from a raw Cookie header string. */
const parseCookieValue = (cookieHeader: string, name: string): string | undefined => {
  for (const pair of cookieHeader.split(';')) {
    const [key, ...rest] = pair.split('=')
    if (key.trim() === name) {
      return rest.join('=').trim()
    }
  }
  return undefined
}

const errorHtml = (message: string) =>
  `<html><head><title>Thunderbolt</title></head>` +
  `<body style="font-family:system-ui,sans-serif;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;background:#f5f5f5">` +
  `<div style="text-align:center;padding:2rem">` +
  `<h2>Authentication Error</h2>` +
  `<p>${message}</p>` +
  `</div></body></html>`

/**
 * Desktop SSO endpoints for Tauri.
 *
 * Two endpoints work together to bridge the SSO flow from the system browser
 * back to the Tauri app's loopback server:
 *
 * 1. `/desktop-initiate` — The system browser navigates here directly. It calls
 *    Better Auth's `/sign-in/sso` internally and redirects the browser to the IdP,
 *    ensuring state cookies are set in the system browser context.
 *
 * 2. `/desktop-callback` — After SSO completes, Better Auth redirects here.
 *    Reads the session cookie (already a signed bearer token) and redirects
 *    to the Tauri loopback server with the token as a query parameter.
 *
 * Mounted under `/api/auth/sso/` so cookies share the same path as
 * Better Auth's SSO callback endpoints.
 */
export const createSsoDesktopCallbackRoutes = () =>
  new Elysia({ prefix: '/api/auth/sso' })
    .onError(safeErrorHandler)

    // Step 1: System browser navigates here → internally calls Better Auth → redirects to IdP
    .get(
      '/desktop-initiate',
      async ({ query, request }) => {
        const port = Number(query.loopback_port)
        if (!ALLOWED_LOOPBACK_PORTS.has(port)) {
          return new Response(errorHtml('Invalid loopback port. Please try signing in again from the app.'), {
            status: 400,
            headers: { 'content-type': 'text/html' },
          })
        }

        const settings = getSettings()
        const baseUrl = settings.betterAuthUrl
        const callbackURL = `${baseUrl}/v1/api/auth/sso/desktop-callback?loopback_port=${port}`

        // Call Better Auth's SSO sign-in endpoint via HTTP. Uses the configured
        // betterAuthUrl which works behind reverse proxies. A direct internal API call
        // would avoid the network hop but couples tightly to Better Auth internals.
        const ssoResponse = await fetch(`${baseUrl}/v1/api/auth/sign-in/sso`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ providerId: 'sso', callbackURL }),
        })

        if (!ssoResponse.ok) {
          const text = await ssoResponse.text().catch(() => 'unknown error')
          console.error('SSO initiate failed:', ssoResponse.status, text)
          return new Response(errorHtml('Failed to initiate SSO. Please try again.'), {
            status: 502,
            headers: { 'content-type': 'text/html' },
          })
        }

        const data = (await ssoResponse.json()) as { url: string }

        // Generate a one-time nonce to bind desktop-initiate to desktop-callback.
        // Prevents CSRF: an attacker can't trick a browser into hitting desktop-callback
        // directly because the nonce cookie is only set here (same-origin, HttpOnly).
        const nonce = randomBytes(32).toString('base64url')

        // Build a redirect response that forwards Better Auth's Set-Cookie headers
        // (state/CSRF cookies) so the system browser has them for the callback
        const headers = new Headers({ location: data.url })
        for (const cookie of ssoResponse.headers.getSetCookie()) {
          headers.append('set-cookie', cookie)
        }
        const isSecure = request.url.startsWith('https') || request.headers.get('x-forwarded-proto') === 'https'
        const secureSuffix = isSecure ? '; Secure' : ''
        headers.append(
          'set-cookie',
          `${NONCE_COOKIE_NAME}=${nonce}; HttpOnly; SameSite=Lax; Path=/v1/api/auth/sso; Max-Age=600${secureSuffix}`,
        )

        return new Response(null, { status: 302, headers })
      },
      {
        query: t.Object({
          loopback_port: t.String(),
        }),
      },
    )

    // Step 2: After SSO completes → read session cookie → redirect to loopback with token
    .get(
      '/desktop-callback',
      ({ request, query }) => {
        const port = Number(query.loopback_port)
        if (!ALLOWED_LOOPBACK_PORTS.has(port)) {
          return new Response(errorHtml('Invalid loopback port. Please try signing in again from the app.'), {
            status: 400,
            headers: { 'content-type': 'text/html' },
          })
        }

        const cookieHeader = request.headers.get('cookie') ?? ''

        // Verify the nonce cookie set by desktop-initiate to prevent CSRF.
        // We check presence, not value — the real protection comes from the cookie
        // attributes (HttpOnly, SameSite=Lax, scoped Path) which ensure only a
        // legitimate desktop-initiate flow can set this cookie. Server-side value
        // validation would require a session store for negligible security gain.
        const nonce = parseCookieValue(cookieHeader, NONCE_COOKIE_NAME)
        if (!nonce) {
          return new Response(errorHtml('Invalid request. Please start the sign-in flow from the app.'), {
            status: 403,
            headers: { 'content-type': 'text/html' },
          })
        }

        const encodedToken = parseCookieValue(cookieHeader, SESSION_COOKIE_NAME)
        if (!encodedToken) {
          return new Response(errorHtml('Session not found. Please try signing in again from the app.'), {
            status: 401,
            headers: { 'content-type': 'text/html' },
          })
        }

        // The cookie value is already a signed bearer token (rawToken.signature)
        // and may be URL-encoded by the browser. Decode it before forwarding.
        const bearerToken = decodeURIComponent(encodedToken)

        // Clear the nonce cookie so it can't be replayed
        return new Response(null, {
          status: 302,
          headers: [
            ['location', `http://127.0.0.1:${port}/?token=${encodeURIComponent(bearerToken)}`],
            ['set-cookie', `${NONCE_COOKIE_NAME}=; HttpOnly; SameSite=Lax; Path=/v1/api/auth/sso; Max-Age=0`],
          ],
        })
      },
      {
        query: t.Object({
          loopback_port: t.String(),
        }),
      },
    )
