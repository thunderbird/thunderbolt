/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterEach, expect, it, mock, spyOn } from 'bun:test'
import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import * as platform from '@/lib/platform'
import { mobileOAuthRedirectUri } from '@/lib/oauth-redirect'
import {
  cancelTinfoilMobileConnection,
  captureTinfoilMobileReturn,
  getTinfoilMobileReturn,
  startTinfoilMobileConnection,
  type TinfoilReturnContext,
} from '@/lib/tinfoil-mobile-auth'
import TinfoilCallback from './tinfoil-callback'

afterEach(() => {
  cleanup()
  cancelTinfoilMobileConnection()
  mock.restore()
})

it.each(['onboarding', 'connections'] as const)(
  'returns the native callback to its %s setup surface',
  async (context: TinfoilReturnContext) => {
    spyOn(platform, 'isTauri').mockReturnValue(true)
    spyOn(platform, 'isMobile').mockReturnValue(true)
    const nonce = 'n'.repeat(43)
    await startTinfoilMobileConnection(
      context,
      { provider: 'tinfoil', revision: 'initial' },
      new AbortController().signal,
      {
        currentPath: () => '/settings/connections',
        verifier: () => nonce,
        challenge: async () => 'challenge',
        openUrl: async () => {},
      },
    )
    const exchange = mock(async () => ({ access_token: 'token', expires_at: Date.now() + 900_000 }))
    captureTinfoilMobileReturn(new URL(`${mobileOAuthRedirectUri}?code=code&state=${nonce}`), { exchange })
    render(
      <MemoryRouter initialEntries={['/oauth/tinfoil']}>
        <Routes>
          <Route path="/oauth/tinfoil" element={<TinfoilCallback />} />
          <Route path="/chats/new" element={<p>Onboarding</p>} />
          <Route path="/settings/connections" element={<p>Connections</p>} />
        </Routes>
      </MemoryRouter>,
    )
    expect(screen.getByText(context === 'onboarding' ? 'Onboarding' : 'Connections')).toBeInTheDocument()
    expect(getTinfoilMobileReturn(context)).not.toBeNull()
    expect(exchange).not.toHaveBeenCalled()
  },
)
