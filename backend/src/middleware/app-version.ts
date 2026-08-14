/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { Settings } from '@/config/settings'
import { compareSemver } from '@shared/compare-semver'
import { Elysia } from 'elysia'

/**
 * Path prefixes exempt from the minimum-app-version gate. These are reached by
 * callers that cannot attach an `X-App-Version` header: bootstrap/config,
 * health checks, browser-redirect SSO/SAML/desktop callbacks, headless CLI
 * device-grant polling, posthog-js capture, and the proxy WebSocket upgrade
 * (browsers can't set headers on WebSocket handshakes).
 */
export const appVersionExemptPrefixes = [
  '/v1/config',
  '/v1/health',
  '/static',
  '/v1/api/auth/sso',
  '/v1/api/auth/device',
  '/v1/posthog',
  '/v1/proxy/ws',
] as const

/** Settings the gate reads — a full `Settings` is assignable, keeping tests free of a cast. */
type AppVersionSettings = Pick<Settings, 'minAppVersion'>

/** Semver core the gate accepts, mirroring `compareSemver`'s parseable set (`N.N.N` + optional pre-release/build). */
const semverPattern = /^\d+\.\d+\.\d+(?:[-+].*)?$/

/**
 * Whether a request bypasses the app-version gate. `OPTIONS` preflights are
 * always exempt; otherwise the pathname must fall under an exempt prefix.
 */
export const isExempt = (pathname: string, method: string): boolean => {
  if (method === 'OPTIONS') {
    return true
  }
  // Segment-boundary match: exempt the exact path or any child under it, never a
  // lookalike sibling (`/v1/config` must not exempt a future `/v1/configuration`).
  return appVersionExemptPrefixes.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`))
}

/**
 * Global gate that hard-blocks clients running below `settings.minAppVersion`.
 * Empty `minAppVersion` disables the gate. Mounted after CORS so short-circuited
 * 426s still carry `Access-Control-Allow-Origin`, and after HTTP logging so
 * they're access-logged.
 *
 * Fails closed: a missing or unparseable `X-App-Version` header is treated as
 * unsupported (`compareSemver` returns 0 for unparseable input, so it cannot
 * detect this on its own — hence the explicit checks).
 *
 * Never throws — plugin `.onError` handlers don't reach the root error middleware
 * (INV-50), so the 426 envelope is returned directly with `set.status` set.
 *
 * Non-browser API-key/PAT clients (`x-api-key`) hit gated routes and must start
 * sending `X-App-Version` once this gate is enabled; they are not exempted by
 * auth scheme, only header-less callers are exempted by prefix above.
 */
export const createAppVersionMiddleware = (settings: AppVersionSettings) =>
  new Elysia({ name: 'app-version' }).onRequest((ctx) => {
    const { minAppVersion } = settings
    if (!minAppVersion) {
      return
    }

    const { pathname } = new URL(ctx.request.url)
    if (isExempt(pathname, ctx.request.method)) {
      return
    }

    const appVersion = ctx.request.headers.get('x-app-version')
    const unsupported = !appVersion || !semverPattern.test(appVersion) || compareSemver(appVersion, minAppVersion) < 0
    if (!unsupported) {
      return
    }

    ctx.set.status = 426
    return {
      success: false,
      data: null,
      error: 'Upgrade Required',
      code: 'APP_VERSION_UNSUPPORTED',
      minAppVersion,
    }
  })
