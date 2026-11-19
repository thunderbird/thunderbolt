/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it } from 'bun:test'
import { setAuthToken, clearAuthToken } from '@/lib/auth-token'
import { clearCachedSession, setCachedSession } from '@/lib/session-cache'
import { useLocalSettingsStore } from '@/stores/local-settings-store'
import { getOnboardingSteps } from './use-onboarding-state'
import { useNeedsOwnModel } from './use-needs-own-model'

beforeEach(() => {
  clearAuthToken()
  clearCachedSession()
  useLocalSettingsStore.setState({ cloudUrl: 'https://server.example/v1', localMode: false })
})
afterEach(() => {
  cleanup()
  clearAuthToken()
  clearCachedSession()
  useLocalSettingsStore.setState({ cloudUrl: '', localMode: true })
})
it.each([true, false])('skips backend onboarding without a session regardless of localMode: %s', (localMode) => {
  useLocalSettingsStore.setState({ localMode })
  const { result } = renderHook(useNeedsOwnModel)
  expect(result.current).toBe(true)
  expect(getOnboardingSteps(result.current)).not.toContain(2)
  expect(getOnboardingSteps(result.current)).not.toContain(4)
  act(() => setAuthToken('session'))
  expect(result.current).toBe(false)
  expect(getOnboardingSteps(result.current)).toContain(2)
  expect(getOnboardingSteps(result.current)).toContain(4)
  act(() => clearAuthToken())
  expect(result.current).toBe(true)
})
it('accepts a valid cookie session and rejects an expired one', () => {
  const { result } = renderHook(useNeedsOwnModel)
  act(() =>
    setCachedSession({ user: { id: 'user' }, session: { expiresAt: new Date(Date.now() + 60000).toISOString() } }),
  )
  expect(result.current).toBe(false)
  act(() =>
    setCachedSession({ user: { id: 'user' }, session: { expiresAt: new Date(Date.now() - 60000).toISOString() } }),
  )
  expect(result.current).toBe(true)
})
