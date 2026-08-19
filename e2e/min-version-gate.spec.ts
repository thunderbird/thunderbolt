/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { test, expect, type Request, type Route } from '@playwright/test'
import { collectPageErrors, loginViaOidc } from './helpers'

/**
 * End-to-end coverage for the minimum-app-version gate (backend
 * `createAppVersionMiddleware` + frontend `<UpgradeRequired>` blocker).
 *
 * Ports mirror playwright.config.ts. `VITE_APP_VERSION` is build-fixed (currently
 * 0.1.123), so the only lever for "out of date" is the SERVER's `MIN_APP_VERSION`.
 * The `min-version-gate` webServer pair (frontend :1423 → backend :8004) pins it
 * to `gateMinAppVersion` so every request from this build is genuinely below-min;
 * the ungated OIDC frontend (:1421 → :8002) drives the run-normally, runtime-flip,
 * and header-coverage scenarios via `loginViaOidc`.
 */
const oidcVitePort = 1421
const oidcBackendPort = 8002
const gateVitePort = 1423
const gateBackendPort = 8004
const gateMinAppVersion = '99.0.0'

const oidcOrigin = `http://localhost:${oidcVitePort}`
const gateFrontendUrl = `http://localhost:${gateVitePort}/`
const gateBackend = `http://localhost:${gateBackendPort}`
const ungatedBackend = `http://localhost:${oidcBackendPort}`

/** The 426 envelope the backend gate returns (backend/src/middleware/app-version.ts). */
const upgradeEnvelope = {
  success: false,
  data: null,
  error: 'Upgrade Required',
  code: 'APP_VERSION_UNSUPPORTED',
  minAppVersion: gateMinAppVersion,
}

const semver = /^\d+\.\d+\.\d+/

/**
 * Fulfill an intercepted cross-origin backend request with a chosen status,
 * echoing the CORS headers the real backend emits so the browser exposes the
 * response to app code (a CORS-blocked fetch would reject before the app's
 * 426/401 handlers ever run). Preflights are answered 204 so the gated GET/POST
 * that follows is allowed to proceed.
 */
const fulfillWithCors = (route: Route, status: number, body: unknown): Promise<void> => {
  const req = route.request()
  const cors: Record<string, string> = {
    'Access-Control-Allow-Origin': oidcOrigin,
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': req.headers()['access-control-request-headers'] ?? '*',
  }
  if (req.method() === 'OPTIONS') {
    return route.fulfill({ status: 204, headers: cors })
  }
  return route.fulfill({ status, contentType: 'application/json', headers: cors, body: JSON.stringify(body) })
}

/** First captured request matching `matchUrl` whose `X-App-Version` header is a semver string. */
const findWithAppVersion = async (requests: Request[], matchUrl: (url: string) => boolean): Promise<string | null> => {
  for (const request of requests) {
    if (!matchUrl(request.url())) {
      continue
    }
    const version = (await request.allHeaders())['x-app-version']
    if (version && semver.test(version)) {
      return version
    }
  }
  return null
}

test.describe('minimum app-version gate', () => {
  test('below-min build is hard-blocked: UpgradeRequired renders, textarea never appears, sync cannot start', async ({
    page,
  }) => {
    const errors = collectPageErrors(page)

    const gatedStatuses = new Map<string, number[]>()
    page.on('response', (response) => {
      const url = response.url()
      if (!url.startsWith(gateBackend)) {
        return
      }
      const key = new URL(url).pathname
      gatedStatuses.set(key, [...(gatedStatuses.get(key) ?? []), response.status()])
    })

    // Load the app against the gated backend. `/config` (exempt) returns
    // `minAppVersion`, so the client renders the blocker straight from a real
    // server response — no interception.
    await page.goto(gateFrontendUrl)

    await expect(page.getByRole('heading', { name: 'Update required' })).toBeVisible({ timeout: 30_000 })
    // The composer lives deep inside the app tree, which the upgrade gate replaces
    // wholesale — so it must never mount.
    await expect(page.locator('textarea')).toHaveCount(0)

    // "Sync cannot start" — on this fresh profile `isSyncEnabled()` is false, so
    // connect is never attempted. The returning-user case (sync already enabled)
    // is the one that matters and is covered separately below.
    const tokenStatuses = gatedStatuses.get('/v1/powersync/token') ?? []
    expect(tokenStatuses).not.toContain(200)

    // The block is enforced server-side, not merely a client render: a direct
    // below-min sync-token request to the gated backend is rejected with 426.
    const gated = await page.request.get(`${gateBackend}/v1/powersync/token`, {
      headers: { 'X-App-Version': '0.1.123' },
    })
    expect(gated.status()).toBe(426)

    expect(errors).toHaveLength(0)
  })

  test('below-min build with sync already enabled never opens a sync stream', async ({ page }) => {
    const errors = collectPageErrors(page)

    const syncRequests: string[] = []
    page.on('request', (request) => {
      const url = request.url()
      if (url.startsWith(gateBackend) && /\/v1\/powersync\/(token|upload)/.test(url)) {
        syncRequests.push(new URL(url).pathname)
      }
    })

    // A returning user: sync already on and the enforced minimum already persisted
    // from a previous session's `/config`. This is the case that produced plaintext
    // uploads — the blocker renders, but `initialize()` used to connect anyway
    // (`syncEnabled` is true), holding a stream and queueing CRUD ops that flush
    // after the upgrade, before the E2EE keyring exists.
    await page.addInitScript(
      ([minVersion]) => {
        window.localStorage.setItem(
          'thunderbolt-local-settings',
          JSON.stringify({ state: { syncEnabled: true }, version: 0 }),
        )
        window.localStorage.setItem(
          'thunderbolt-config',
          JSON.stringify({ state: { config: { minAppVersion: minVersion } }, version: 0 }),
        )
      },
      [gateMinAppVersion],
    )

    await page.goto(gateFrontendUrl)
    await expect(page.getByRole('heading', { name: 'Update required' })).toBeVisible({ timeout: 30_000 })

    // Give the fire-and-forget connect from `initialize()` room to have happened.
    await page.waitForTimeout(3_000)

    // The persisted minimum is enough for `isAppVersionUnsupported()` to refuse the
    // connect outright, so the stale client never even asks for a sync token.
    expect(syncRequests).toEqual([])

    expect(errors).toHaveLength(0)
  })

  test('at-or-above min runs normally: app loads and backend calls are not gated', async ({ page }) => {
    const errors = collectPageErrors(page)

    // Collect backend responses from the start so calls fired during login aren't
    // missed (listener-before-action).
    const backendStatuses: number[] = []
    page.on('response', (response) => {
      if (response.url().startsWith(`${ungatedBackend}/v1/`)) {
        backendStatuses.push(response.status())
      }
    })

    // Ungated backend (:8002 has no MIN_APP_VERSION) via the standard OIDC login.
    await loginViaOidc(page)
    await expect(page.locator('textarea')).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Update required' })).not.toBeVisible()

    // Not gated: representative authenticated backend calls resolve (200) and the
    // gate never turns any request into a 426.
    await expect.poll(() => backendStatuses, { timeout: 30_000 }).toContain(200)
    expect(backendStatuses).not.toContain(426)

    expect(errors).toHaveLength(0)
  })

  test('backend gate spans every route but exempts config, health, preflight and SSO callbacks', async ({
    request,
  }) => {
    const belowMin = { 'X-App-Version': '0.1.123' }

    // Non-exempt route below-min → 426 with the upgrade envelope.
    const gated = await request.get(`${gateBackend}/v1/powersync/token`, { headers: belowMin })
    expect(gated.status()).toBe(426)
    const gatedBody = (await gated.json()) as typeof upgradeEnvelope
    expect(gatedBody.code).toBe('APP_VERSION_UNSUPPORTED')
    expect(gatedBody.minAppVersion).toBe(gateMinAppVersion)

    // Exempt: bootstrap config succeeds and advertises the enforced minimum.
    const config = await request.get(`${gateBackend}/v1/config`, { headers: belowMin })
    expect(config.status()).toBe(200)
    expect(((await config.json()) as { minAppVersion?: string }).minAppVersion).toBe(gateMinAppVersion)

    // Exempt: health check.
    const health = await request.get(`${gateBackend}/v1/health`, { headers: belowMin })
    expect(health.status()).not.toBe(426)

    // Exempt: OPTIONS preflight is always allowed through (browsers can't set the
    // header on a preflight).
    const preflight = await request.fetch(`${gateBackend}/v1/powersync/token`, {
      method: 'OPTIONS',
      headers: belowMin,
    })
    expect(preflight.status()).not.toBe(426)

    // Exempt: browser-redirect SSO callbacks (no header to send). The route itself
    // may 4xx, but the gate must not turn it into a 426.
    const ssoCallback = await request.get(`${gateBackend}/v1/api/auth/sso/callback/thunderbolt`, { headers: belowMin })
    expect(ssoCallback.status()).not.toBe(426)
  })

  test('a runtime 426 response raises the blocker mid-session without a reload and wins over the sign-in modal', async ({
    page,
  }) => {
    const errors = collectPageErrors(page)

    // Ungated backend: no config-driven gate, so the blocker can ONLY come from a
    // live 426 event (the transient `forceUpgrade` flag), never from re-deriving
    // config on load. Inject the backend's 426 envelope on the http-client
    // discovery call (fires reliably on login), and a 401 on the sync-token call to
    // pop the sign-in modal — the upgrade blocker must supersede it.
    await page.route(`${ungatedBackend}/v1/agents`, (route) => fulfillWithCors(route, 426, upgradeEnvelope))
    await page.route(`${ungatedBackend}/v1/powersync/token`, (route) =>
      fulfillWithCors(route, 401, { success: false, error: 'Unauthorized' }),
    )

    // Session is established via the untouched auth routes; the 426 then flips the
    // running app to the blocker. No reload is issued.
    await page.goto('/')
    await expect(page.getByRole('heading', { name: 'Update required' })).toBeVisible({ timeout: 30_000 })

    // Upgrade wins: the blocker replaces the whole app, so the composer is gone and
    // the sign-in modal the 401 tried to open is not shown.
    await expect(page.locator('textarea')).toHaveCount(0)
    await expect(page.getByText('Sign In', { exact: true })).not.toBeVisible()

    // The blocker is the runtime flag, not a config gate: the persisted config
    // carries no `minAppVersion`, so a reload would clear it.
    const configEntry = await page.evaluate(() => localStorage.getItem('thunderbolt-config'))
    const persisted = configEntry ? (JSON.parse(configEntry) as { state?: { config?: { minAppVersion?: string } } }) : null
    expect(persisted?.state?.config?.minAppVersion).toBeUndefined()

    expect(errors).toHaveLength(0)
  })

  test('requests to our backend carry X-App-Version while proxied upstream calls do not', async ({ page }) => {
    const errors = collectPageErrors(page)

    const requests: Request[] = []
    page.on('request', (request) => requests.push(request))

    await loginViaOidc(page)
    // Poll the requests captured since before login (no listener-after-action race) until
    // the representative backend call has fired — sync-token isn't observable here, as
    // connect is gated behind isSyncEnabled(), which OIDC login doesn't enable.
    await expect
      .poll(() => requests.some((request) => request.url().includes('/v1/agents')), { timeout: 30_000 })
      .toBe(true)

    // Auth and the http-client discovery call both identify the build to our backend.
    const authVersion = await findWithAppVersion(requests, (url) => url.startsWith(`${ungatedBackend}/v1/api/auth/`))
    expect(authVersion).toMatch(semver)
    const agentsVersion = await findWithAppVersion(requests, (url) => url.includes('/v1/agents'))
    expect(agentsVersion).toMatch(semver)

    // The proxy path (app's real `createProxyFetch`): the outer hop to our backend
    // carries X-App-Version, but it is NEVER promoted to a passthrough header bound
    // for the external upstream (`skipHeaders` in src/lib/proxy-fetch.ts).
    const proxyHeaders = await page.evaluate(
      async ({ cloudUrl, target }) => {
        // Vite dev serves app source under `/src/...`; the module is already in the
        // running app's graph, so this resolves the real `createProxyFetch`. Cast via
        // a string so TS types the runtime URL import as the app module.
        const modulePath = '/src/lib/proxy-fetch.ts'
        const mod = (await import(/* @vite-ignore */ modulePath)) as typeof import('@/lib/proxy-fetch')
        let outer: Record<string, string> = {}
        const fetchImpl = (async (req: Request) => {
          outer = Object.fromEntries((req as unknown as globalThis.Request).headers.entries())
          return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
        }) as unknown as typeof fetch
        const proxyFetch = mod.createProxyFetch({
          cloudUrl,
          fetchImpl,
          isStandalone: () => false,
          getProxyEnabled: () => true,
        })
        await proxyFetch(target, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer sk-upstream' },
          body: '{}',
        })
        return outer
      },
      { cloudUrl: `${ungatedBackend}/v1`, target: 'https://api.example.com/v1/chat/completions' },
    )

    expect(proxyHeaders['x-app-version']).toMatch(semver)
    expect(proxyHeaders['x-proxy-passthrough-x-app-version']).toBeUndefined()
    // Sanity: genuine caller headers ARE promoted, proving the app-version omission
    // is deliberate rather than incidental.
    expect(proxyHeaders['x-proxy-passthrough-authorization']).toBe('Bearer sk-upstream')

    expect(errors).toHaveLength(0)
  })
})
