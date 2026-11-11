/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterEach, describe, expect, it } from 'bun:test'
import { useConfigStore } from '@/api/config-store'
import { isAltchaCaptchaEnabled, isAnonymousAuthEnabled, isSsoMode, resolveSsoMode } from './auth-mode'

const originalConfig = useConfigStore.getState().config
afterEach(() => useConfigStore.setState({ config: originalConfig }))

describe('server authentication discovery', () => {
  it('supports OIDC and SAML servers in a generic client', () => {
    expect(resolveSsoMode('oidc', 'thunderbolt')).toBe(true)
    expect(resolveSsoMode('saml', 'thunderbolt')).toBe(true)
    expect(resolveSsoMode('consumer', 'thunderbolt')).toBe(false)
  })

  it('keeps managed builds in SSO mode even if the server says consumer', () => {
    expect(resolveSsoMode('consumer', 'sso')).toBe(true)
    expect(resolveSsoMode(undefined, 'sso')).toBe(true)
  })

  it('retains build defaults for servers without authentication discovery', () => {
    expect(resolveSsoMode(undefined, 'thunderbolt')).toBe(false)
  })

  it('reads the selected server capabilities', () => {
    useConfigStore.setState({ config: { authMode: 'oidc', authAllowAnonymous: true, captchaProvider: 'altcha' } })
    expect(isSsoMode()).toBe(true)
    expect(isAnonymousAuthEnabled()).toBe(true)
    expect(isAltchaCaptchaEnabled()).toBe(true)
  })

  it('honors explicit disabled capabilities', () => {
    useConfigStore.setState({ config: { authAllowAnonymous: false, captchaProvider: 'none' } })
    expect(isAnonymousAuthEnabled()).toBe(false)
    expect(isAltchaCaptchaEnabled()).toBe(false)
  })
})
