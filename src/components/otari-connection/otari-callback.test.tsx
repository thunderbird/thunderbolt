/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { I18nProvider } from '@lingui/react'
import { render, screen } from '@testing-library/react'
import { afterEach, expect, mock, spyOn, test } from 'bun:test'
import { StrictMode } from 'react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { i18n } from '@/i18n'
import {
  captureOtariMobileReturn,
  clearOtariBrowserReturn,
  getOtariBrowserReturn,
  startOtariBrowserConnection,
} from '@/lib/otari-browser-auth'
import { OtariCallback } from './otari-callback'

const nonce = 'c'.repeat(43)
const originalLocation = window.location
const originalStorage = Object.getOwnPropertyDescriptor(window, 'sessionStorage')!
const storage = window.sessionStorage

/** Render the actual callback route while keeping navigation inside the test router. */
const renderCallback = (query: string) => {
  const callbackUrl = new URL(`https://app.test/oauth/otari${query}`)
  Object.defineProperty(window, 'location', { value: callbackUrl, configurable: true, writable: true })
  spyOn(window.history, 'replaceState').mockImplementation((_state, _unused, url) => {
    Object.defineProperty(window, 'location', {
      value: new URL(String(url), callbackUrl),
      configurable: true,
      writable: true,
    })
  })
  return render(
    <StrictMode>
      <I18nProvider i18n={i18n}>
        <MemoryRouter initialEntries={[`${callbackUrl.pathname}${callbackUrl.search}`]}>
          <Routes>
            <Route path="/oauth/otari" element={<OtariCallback />} />
            <Route path="/settings/models" element={<output>Model setup</output>} />
            <Route path="/chats/new" element={<output>Thunderbolt</output>} />
          </Routes>
        </MemoryRouter>
      </I18nProvider>
    </StrictMode>,
  )
}

/** Store a real pending request without leaving the test page. */
const prepareConnection = () =>
  startOtariBrowserConnection(
    'http://localhost:8099',
    'models',
    new AbortController().signal,
    { provider: 'otari', revision: 'before-authorization' },
    {
      storage: () => storage,
      currentUrl: () => new URL('https://app.test/settings/models'),
      navigate: () => {},
      verifier: () => nonce,
    },
  )

afterEach(() => {
  clearOtariBrowserReturn(nonce)
  storage.removeItem('thunderbolt.otari.authorization')
  localStorage.removeItem('thunderbolt.otari.authorization')
  Object.defineProperty(window, 'location', { value: originalLocation, configurable: true, writable: true })
  Object.defineProperty(window, 'sessionStorage', originalStorage)
  mock.restore()
})

test('scrubs credentials and returns to the owning screen once under StrictMode', async () => {
  await prepareConnection()
  renderCallback(`?code=one-use-code&state=${nonce}`)
  expect(screen.getByRole('status')).toHaveTextContent('Model setup')
  expect(window.location.search).toBe('')
  expect(window.location.hash).toBe('')
  expect(getOtariBrowserReturn('models')).toMatchObject({
    id: nonce,
    origin: 'http://localhost:8099',
    attempt: { provider: 'otari', revision: 'before-authorization' },
    error: null,
  })
})

test('scrubs and rejects a callback containing an unexpected fragment', async () => {
  await prepareConnection()
  renderCallback(`?code=one-use-code&state=${nonce}#private-fragment`)
  expect(screen.getByRole('heading')).toHaveTextContent('Connection not completed')
  expect(window.location.search).toBe('')
  expect(window.location.hash).toBe('')
  expect(getOtariBrowserReturn('models')).toBeNull()
})

test('returns a provider denial to setup without exposing its details', async () => {
  await prepareConnection()
  renderCallback(`?error=access_denied&error_description=private-detail&state=${nonce}`)
  expect(screen.getByRole('status')).toHaveTextContent('Model setup')
  expect(i18n._(getOtariBrowserReturn('models')!.error!)).toContain('Connection cancelled')
  expect(i18n._(getOtariBrowserReturn('models')!.error!)).not.toContain('private-detail')
  expect(window.location.search).toBe('')
})

test('offers a same-tab recovery link when there is no pending request', () => {
  renderCallback(`?code=unbound-code&state=${nonce}`)
  expect(screen.getByRole('heading')).toHaveTextContent('Connection not completed')
  expect(screen.getByRole('link', { name: 'Return to Thunderbolt' })).toHaveAttribute('href', '/chats/new')
  expect(screen.queryByRole('button', { name: 'Close this window' })).not.toBeInTheDocument()
  expect(window.location.search).toBe('')
})

test('resumes a captured native app link without putting the code in the WebView URL', () => {
  localStorage.setItem(
    'thunderbolt.otari.authorization',
    JSON.stringify({
      state: nonce,
      verifier: nonce,
      origin: 'https://otari.ai',
      redirectUri: 'https://app.thunderbolt.io/oauth/callback',
      returnTo: '/settings/models',
      context: 'models',
      attempt: { provider: 'otari', revision: 'before-authorization' },
      createdAt: Date.now(),
    }),
  )
  captureOtariMobileReturn(new URL(`https://app.thunderbolt.io/oauth/callback?code=one-use&state=${nonce}`))
  renderCallback('')
  expect(screen.getByRole('status')).toHaveTextContent('Model setup')
  expect(window.location.search).toBe('')
  expect(getOtariBrowserReturn('models')?.error).toBeNull()
})

test('still scrubs the authorization code and shows recovery when tab storage is blocked', async () => {
  await prepareConnection()
  Object.defineProperty(window, 'sessionStorage', {
    configurable: true,
    get: () => {
      throw new DOMException('Browser storage blocked', 'SecurityError')
    },
  })
  renderCallback(`?code=one-use-code&state=${nonce}`)
  expect(screen.getByRole('heading')).toHaveTextContent('Connection not completed')
  expect(window.location.search).toBe('')
  expect(getOtariBrowserReturn('models')).toBeNull()
})
