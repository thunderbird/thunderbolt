/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { randomBytes } from 'crypto'
import type { Settings } from '@/config/settings'
import { resolveAppName } from '@shared/branding'
import { safeErrorHandler } from '@/middleware/error-handling'
import { Elysia, t } from 'elysia'
import { configuredSsoProviderId } from './paths'

const sessionCookieName = 'better-auth.session_token'
const nonceCookieName = 'thunderbolt_desktop_sso_nonce'

/** Allowed loopback ports — must match OAUTH_PORTS in src-tauri/src/commands.rs */
const allowedLoopbackPorts = new Set([17421, 17422, 17423])

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

// The charset is declared because the app name may be any script and the responses send a bare text/html.
const errorHtml = (message: string, appName: string) =>
  `<html><head><meta charset="utf-8"><title>${Bun.escapeHTML(appName)}</title></head>` +
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
export const createSsoDesktopCallbackRoutes = (settings: Settings, fetchFn: typeof fetch = globalThis.fetch) => {
  // Only mount in SSO mode — in consumer mode these endpoints are unused
  // and desktop-initiate would fail with a confusing 502.
  if (settings.authMode === 'consumer') {
    return new Elysia({ prefix: '/api/auth/sso' })
  }

  const errorPage = (message: string) => errorHtml(message, resolveAppName(settings.branding))

  return (
    new Elysia({ prefix: '/api/auth/sso' })
      .onError(safeErrorHandler)

      // Step 1: System browser navigates here → internally calls Better Auth → redirects to IdP
      .get(
        '/desktop-initiate',
        async ({ query, request }) => {
          const port = Number(query.loopback_port)
          if (!allowedLoopbackPorts.has(port)) {
            return new Response(errorPage('Invalid loopback port. Please try signing in again from the app.'), {
              status: 400,
              headers: { 'content-type': 'text/html' },
            })
          }

          const baseUrl = settings.betterAuthUrl
          const callbackURL = `${baseUrl}/v1/api/auth/sso/desktop-callback?loopback_port=${port}`

          // Call Better Auth's SSO sign-in endpoint via HTTP. Uses the configured
          // betterAuthUrl which works behind reverse proxies. A direct internal API call
          // would avoid the network hop but couples tightly to Better Auth internals.
          const ssoResponse = await fetchFn(`${baseUrl}/v1/api/auth/sign-in/sso`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            // Without errorCallbackURL, Better Auth sends a failed login to its own error page on the API host.
            body: JSON.stringify({ providerId: configuredSsoProviderId, callbackURL, errorCallbackURL: callbackURL }),
          })

          if (!ssoResponse.ok) {
            const text = await ssoResponse.text().catch(() => 'unknown error')
            console.error('SSO initiate failed:', ssoResponse.status, text)
            return new Response(errorPage('Failed to initiate SSO. Please try again.'), {
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
            `${nonceCookieName}=${nonce}; HttpOnly; SameSite=Lax; Path=/v1/api/auth/sso; Max-Age=600${secureSuffix}`,
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
          if (!allowedLoopbackPorts.has(port)) {
            return new Response(errorPage('Invalid loopback port. Please try signing in again from the app.'), {
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
          const nonce = parseCookieValue(cookieHeader, nonceCookieName)
          if (!nonce) {
            return new Response(errorPage('Invalid request. Please start the sign-in flow from the app.'), {
              status: 403,
              headers: { 'content-type': 'text/html' },
            })
          }

          // Clear the nonce cookie so it can't be replayed
          const redirectToApp = (search: string) =>
            new Response(null, {
              status: 302,
              headers: [
                ['location', `http://127.0.0.1:${port}/?${search}`],
                ['set-cookie', `${nonceCookieName}=; HttpOnly; SameSite=Lax; Path=/v1/api/auth/sso; Max-Age=0`],
              ],
            })

          // A failed login arrives here too (see errorCallbackURL in desktop-initiate): hand the code to the app.
          if (query.error) {
            return redirectToApp(`error=${encodeURIComponent(query.error)}`)
          }

          const encodedToken = parseCookieValue(cookieHeader, sessionCookieName)
          if (!encodedToken) {
            return new Response(errorPage('Session not found. Please try signing in again from the app.'), {
              status: 401,
              headers: { 'content-type': 'text/html' },
            })
          }

          // The cookie value is already a signed bearer token (rawToken.signature)
          // and may be URL-encoded by the browser. Decode it before forwarding.
          const bearerToken = decodeURIComponent(encodedToken)

          return redirectToApp(`token=${encodeURIComponent(bearerToken)}`)
        },
        {
          query: t.Object({
            loopback_port: t.String(),
            error: t.Optional(t.String()),
          }),
        },
      )
  )
}
