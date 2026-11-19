/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { act, renderHook } from '@testing-library/react'
import { expect, it } from 'bun:test'
import { clearAuthToken, setAuthToken } from '@/lib/auth-token'
import { clearCachedSession, setCachedSession } from '@/lib/session-cache'
import { useLocalSettingsStore } from '@/stores/local-settings-store'
import { useLocalProviders } from './use-local-providers'

it('keeps local providers until sign-in and follows sign-out without an auth provider', () => {
  useLocalSettingsStore.setState({ cloudUrl: 'https://server.example/v1', localMode: true })
  const { result } = renderHook(useLocalProviders)
  expect(result.current).toBe(true)
  act(() => setAuthToken('session-token'))
  expect(result.current).toBe(false)
  act(() => clearAuthToken())
  expect(result.current).toBe(true)
  act(() => useLocalSettingsStore.setState({ localMode: false }))
  expect(result.current).toBe(false)
  act(() => useLocalSettingsStore.setState({ cloudUrl: '' }))
  expect(result.current).toBe(true)
})

it('recognizes cookie-backed SSO sessions and returns to local providers on sign-out', () => {
  useLocalSettingsStore.setState({ cloudUrl: 'https://server.example/v1', localMode: true })
  const { result } = renderHook(useLocalProviders)
  expect(result.current).toBe(true)
  act(() =>
    setCachedSession({
      user: { id: 'sso-user' },
      session: { expiresAt: new Date(Date.now() + 60_000) },
    }),
  )
  expect(result.current).toBe(false)
  act(() => clearCachedSession())
  expect(result.current).toBe(true)
})

it('does not enable server providers for an expired or incomplete cached session', () => {
  useLocalSettingsStore.setState({ cloudUrl: 'https://server.example/v1', localMode: true })
  setCachedSession({ user: { id: 'sso-user' }, session: { expiresAt: new Date(Date.now() - 60_000) } })
  const { result } = renderHook(useLocalProviders)
  expect(result.current).toBe(true)
  act(() => setCachedSession({ session: { expiresAt: new Date(Date.now() + 60_000) } }))
  expect(result.current).toBe(true)
})
