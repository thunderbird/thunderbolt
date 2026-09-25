/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import * as settingsModule from '@/config/settings'
import type { db as DbType } from '@/db/client'
import { createTestSettings } from '@/test-utils/settings'
import { afterEach, describe, expect, it, spyOn } from 'bun:test'
import { createAuth } from './auth'

// `betterAuth()` builds its context lazily, so the adapter is never asked for a
// connection while we only inspect the resolved options.
const unusedDatabase = {} as typeof DbType

// `AUTH_MODE=oidc` refuses to boot without provider credentials, so SSO cases
// carry them.
const oidcCredentials = {
  oidcIssuer: 'https://idp.example.com',
  oidcClientId: 'test-client-id',
  oidcClientSecret: 'test-client-secret',
}

const optionsFor = (overrides: Partial<settingsModule.Settings> = {}) => {
  const settings = createTestSettings(overrides.authMode === 'oidc' ? { ...oidcCredentials, ...overrides } : overrides)
  spyOn(settingsModule, 'getSettings').mockReturnValue(settings)
  return createAuth(unusedDatabase).options
}

describe('createAuth options', () => {
  afterEach(() => {
    spyOn(settingsModule, 'getSettings').mockRestore()
  })

  it('sends auth failures to the app rather than the API origin', () => {
    const options = optionsFor({ appUrl: 'https://app.example.com' })

    // Without this Better Auth falls back to `${baseURL}/error` on the API
    // origin, which serves no HTML and renders a bare NOT_FOUND.
    expect(options.onAPIError?.errorURL).toBe('https://app.example.com/auth-error')
  })

  it('targets a route outside the auth gate so failures cannot loop', () => {
    const options = optionsFor({ appUrl: 'https://app.example.com', authMode: 'oidc' })

    // The app root would redirect unauthenticated SSO users straight back into
    // /sso-redirect, which starts another IdP round-trip on mount.
    expect(options.onAPIError?.errorURL).not.toBe('https://app.example.com')
    expect(options.onAPIError?.errorURL).toEndWith('/auth-error')
  })

  it('never skips the OAuth state cookie check', () => {
    // The signed state cookie is the only thing binding a callback to the browser
    // that started the flow: the verification row makes state single-use but not
    // browser-bound. Skipping the check reopens login CSRF, so split-origin
    // deployments must keep the app and API same-site instead.
    //
    // Both cases run in SSO mode, where `account` actually exists — in consumer
    // mode it is undefined and the assertion would pass without exercising
    // anything.
    const sameSite = optionsFor({
      authMode: 'oidc',
      appUrl: 'https://app.example.com',
      betterAuthUrl: 'https://api.example.com',
    })
    const crossSite = optionsFor({
      authMode: 'oidc',
      appUrl: 'https://app.vercel.app',
      betterAuthUrl: 'https://api.up.railway.app',
    })

    expect(sameSite.account).toBeDefined()
    expect(sameSite.account).not.toHaveProperty('skipStateCookieCheck')
    expect(crossSite.account).not.toHaveProperty('skipStateCookieCheck')
  })

  it('trusts the sso provider for account linking only in SSO mode', () => {
    expect(optionsFor({ authMode: 'oidc' }).account?.accountLinking?.trustedProviders).toEqual(['sso'])
    expect(optionsFor({ authMode: 'consumer' }).account?.accountLinking).toBeUndefined()
  })
})
