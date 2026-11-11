/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterEach, expect, it, mock } from 'bun:test'
import { mobileOAuthRedirectUri } from './oauth-redirect'
import { createTinfoilAuth } from './tinfoil-auth'
import {
  cancelTinfoilMobileConnection,
  captureTinfoilMobileReturn,
  clearTinfoilMobileReturn,
  getTinfoilMobileReturn,
  startTinfoilMobileConnection,
} from './tinfoil-mobile-auth'

const nonce = 'n'.repeat(43)
const attempt = { provider: 'tinfoil' as const, revision: 'original-revision' }
const tokens = { access_token: 'access', refresh_token: 'refresh', expires_at: 900_000 }
const callback = (query = `code=code&state=${nonce}`, origin = mobileOAuthRedirectUri) => new URL(`${origin}?${query}`)
const dependencies = () => ({
  verifier: () => nonce,
  challenge: async () => 'challenge',
  now: () => 1000,
  openUrl: mock(async (_url: string | URL) => {}),
  exchange: mock(async () => tokens),
})

afterEach(cancelTinfoilMobileConnection)

it('redeems the mobile code directly with a form-encoded grant bound to its verified HTTPS redirect', async () => {
  const requests: Request[] = []
  const auth = createTinfoilAuth('public-client', {
    fetch: async (input) => {
      requests.push(input as Request)
      return Response.json({ access_token: 'access', refresh_token: 'refresh', expires_in: 900, token_type: 'Bearer' })
    },
  })
  const deps = { ...dependencies(), exchange: auth.exchangeCode }
  await startTinfoilMobileConnection('onboarding', attempt, new AbortController().signal, deps)
  expect(await captureTinfoilMobileReturn(callback(), deps)!.complete()).toMatchObject({
    access_token: 'access',
    refresh_token: 'refresh',
  })
  expect(requests).toHaveLength(1)
  expect(requests[0].url).toBe('https://api.tinfoil.sh/oauth/token')
  expect(requests[0].redirect).toBe('error')
  expect(requests[0].credentials).toBe('omit')
  expect(requests[0].headers.get('Content-Type')).toBe('application/x-www-form-urlencoded')
  expect(Object.fromEntries(new URLSearchParams(await requests[0].text()))).toEqual({
    grant_type: 'authorization_code',
    client_id: 'public-client',
    code: 'code',
    code_verifier: nonce,
    redirect_uri: mobileOAuthRedirectUri,
  })
})

it('persists a mobile handoff before opening the system browser and consumes a code once after restart', async () => {
  const deps = dependencies()
  await startTinfoilMobileConnection('connections', attempt, new AbortController().signal, deps)
  const opened = new URL(String(deps.openUrl.mock.calls[0][0]))
  expect(opened.origin).toBe('https://dash.tinfoil.sh')
  expect(opened.searchParams.get('redirect_uri')).toBe(mobileOAuthRedirectUri)
  expect(opened.searchParams.get('code_challenge_method')).toBe('S256')
  expect(opened.searchParams.get('scope')).toBe('inference:api offline_access')
  const returned = captureTinfoilMobileReturn(callback(), deps)!
  expect(returned.returnTo).toBe('/settings/connections')
  expect(returned.attempt).toEqual(attempt)
  expect(getTinfoilMobileReturn('onboarding')).toBeNull()
  expect(getTinfoilMobileReturn('connections')).toBe(returned)
  expect(captureTinfoilMobileReturn(callback(), deps)).toBe(returned)
  expect(await Promise.all([returned.complete(), returned.complete()])).toEqual([tokens, tokens])
  expect(deps.exchange).toHaveBeenCalledTimes(1)
  expect(deps.exchange).toHaveBeenCalledWith(
    { code: 'code', verifier: nonce, redirectUri: mobileOAuthRedirectUri },
    expect.any(AbortSignal),
  )
  clearTinfoilMobileReturn(returned.id)
  expect(captureTinfoilMobileReturn(callback(), deps)).toBeNull()
})

it.each([
  'http://app.thunderbolt.io/oauth/callback',
  'https://app.thunderbolt.io.attacker.example/oauth/callback',
  'https://app.thunderbolt.io/oauth/callback/other',
  'https://user@app.thunderbolt.io/oauth/callback',
])('ignores callbacks outside the exact app link: %s', async (url) => {
  const deps = dependencies()
  await startTinfoilMobileConnection('onboarding', attempt, new AbortController().signal, deps)
  expect(captureTinfoilMobileReturn(callback(undefined, url), deps)).toBeNull()
  expect(captureTinfoilMobileReturn(callback(), deps)?.returnTo).toBe('/chats/new')
  expect(deps.exchange).not.toHaveBeenCalled()
})

it.each([`code=code&state=wrong`, `code=code&state=${nonce}&state=${nonce}`])(
  'does not consume another provider’s or ambiguous state (%s)',
  async (query) => {
    const deps = dependencies()
    await startTinfoilMobileConnection('onboarding', attempt, new AbortController().signal, deps)
    expect(captureTinfoilMobileReturn(callback(query), deps)).toBeNull()
    expect(captureTinfoilMobileReturn(callback(), deps)).not.toBeNull()
  },
)

it.each([`state=${nonce}`, `code=one&code=two&state=${nonce}`, `error=denied&code=one&state=${nonce}`])(
  'does not exchange an invalid or rejected response (%s)',
  async (query) => {
    const deps = dependencies()
    await startTinfoilMobileConnection('onboarding', attempt, new AbortController().signal, deps)
    await expect(captureTinfoilMobileReturn(callback(query), deps)!.complete()).rejects.toThrow('Could not connect')
    expect(deps.exchange).not.toHaveBeenCalled()
  },
)

it.each([0, 601_001])('expires invalid-clock or stale handoffs (%s)', async (now) => {
  const deps = dependencies()
  await startTinfoilMobileConnection('onboarding', attempt, new AbortController().signal, deps)
  const returned = captureTinfoilMobileReturn(callback(), { ...deps, now: () => now })!
  await expect(returned.complete()).rejects.toThrow('Could not connect')
  expect(deps.exchange).not.toHaveBeenCalled()
})

it('cancels before opening or completing authorization and allows a fresh attempt', async () => {
  const deps = dependencies()
  const controller = new AbortController()
  controller.abort()
  await expect(startTinfoilMobileConnection('onboarding', attempt, controller.signal, deps)).rejects.toThrow()
  expect(deps.openUrl).not.toHaveBeenCalled()
  await startTinfoilMobileConnection('onboarding', attempt, new AbortController().signal, deps)
  cancelTinfoilMobileConnection()
  expect(captureTinfoilMobileReturn(callback(), deps)).toBeNull()
  await startTinfoilMobileConnection('onboarding', attempt, new AbortController().signal, deps)
  const returned = captureTinfoilMobileReturn(callback(), deps)!
  cancelTinfoilMobileConnection()
  await expect(returned.complete()).rejects.toThrow()
  expect(deps.exchange).not.toHaveBeenCalled()
})

it('clears the pending verifier when the system browser cannot open', async () => {
  const deps = dependencies()
  await expect(
    startTinfoilMobileConnection('onboarding', attempt, new AbortController().signal, {
      ...deps,
      openUrl: async () => {
        throw new Error('open failed')
      },
    }),
  ).rejects.toThrow('open failed')
  expect(captureTinfoilMobileReturn(callback(), deps)).toBeNull()
})

it('does not erase a newer handoff when an older browser-opening request fails', async () => {
  const deps = dependencies()
  const opening = Promise.withResolvers<void>()
  const old = startTinfoilMobileConnection('onboarding', attempt, new AbortController().signal, {
    ...deps,
    openUrl: () => opening.promise,
  })
  await Promise.resolve()
  const newerNonce = 'x'.repeat(43)
  await startTinfoilMobileConnection('connections', attempt, new AbortController().signal, {
    ...deps,
    verifier: () => newerNonce,
  })
  opening.reject(new Error('old opener failed'))
  await expect(old).rejects.toThrow('old opener failed')
  expect(captureTinfoilMobileReturn(callback(`code=code&state=${newerNonce}`), deps)?.context).toBe('connections')
})
