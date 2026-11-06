/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterEach, expect, it, mock, spyOn } from 'bun:test'
import { render, screen, cleanup } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { I18nProvider } from '@lingui/react'
import { i18n } from '@/i18n'
import { startProviderBrowserConnection, cancelProviderBrowserConnection } from '@/lib/provider-browser-auth'
import OpenRouterCallback from './openrouter-callback'

const originalLocation = window.location
const nonce = 's'.repeat(43)
afterEach(() => {
  cleanup()
  cancelProviderBrowserConnection()
  Object.defineProperty(window, 'location', { value: originalLocation, configurable: true, writable: true })
  mock.restore()
})
it.each(['openrouter', 'tinfoil'] as const)(
  'returns %s to setup in the same tab and removes the code from history',
  async (provider) => {
    const callback = `https://app.test/oauth/${provider}${provider === 'openrouter' ? `/${nonce}` : ''}`
    await startProviderBrowserConnection(
      provider,
      'connections',
      { provider, revision: '1' },
      new AbortController().signal,
      {
        origin: () => 'https://app.test',
        verifier: () => nonce,
        challenge: async () => 'challenge',
        navigate: () => {},
      },
    )
    Object.defineProperty(window, 'location', {
      value: new URL(`${callback}?code=secret&state=${nonce}`),
      configurable: true,
      writable: true,
    })
    const replace = spyOn(window.history, 'replaceState').mockImplementation(() => {})
    const close = spyOn(window, 'close').mockImplementation(() => {})
    render(
      <I18nProvider i18n={i18n}>
        <MemoryRouter>
          <Routes>
            <Route path="/" element={<OpenRouterCallback />} />
            <Route path="/settings/connections" element={<p>Connection setup</p>} />
          </Routes>
        </MemoryRouter>
      </I18nProvider>,
    )
    expect(screen.getByText('Connection setup')).toBeInTheDocument()
    expect(replace).toHaveBeenCalledWith(window.history.state, '', new URL(callback).pathname)
    expect(close).not.toHaveBeenCalled()
  },
)
it('keeps invalid callbacks in the current tab with a return action', () => {
  spyOn(window.history, 'replaceState').mockImplementation(() => {})
  const close = spyOn(window, 'close').mockImplementation(() => {})
  render(
    <I18nProvider i18n={i18n}>
      <MemoryRouter>
        <OpenRouterCallback />
      </MemoryRouter>
    </I18nProvider>,
  )
  expect(screen.getByRole('link')).toBeInTheDocument()
  expect(close).not.toHaveBeenCalled()
})
