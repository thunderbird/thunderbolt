/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { resetTestDatabase, setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { createMockAuthClient } from '@/test-utils/auth-client'
import { createTestProvider } from '@/test-utils/test-provider'
import { act, renderHook } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test'
import * as passkeys from '@/lib/passkey'
import { useOnboardingPasskeyStepState } from './use-onboarding-passkey-step-state'

/** Render the hook with an auth client whose passkey endpoints all answer `error`. */
const renderStep = (error: unknown) => {
  const authClient = createMockAuthClient({ fetch: async () => ({ data: null, error }) })
  return renderHook(() => useOnboardingPasskeyStepState(), { wrapper: createTestProvider({ authClient }) })
}

describe('useOnboardingPasskeyStepState', () => {
  beforeAll(async () => {
    await setupTestDatabase()
  })

  afterAll(async () => {
    await teardownTestDatabase()
  })

  beforeEach(() => {
    spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(async () => {
    mock.restore()
    await resetTestDatabase()
  })

  it('opens one registration prompt for synchronous duplicate submissions', async () => {
    const pending = Promise.withResolvers<Awaited<ReturnType<typeof passkeys.registerPasskey>>>()
    const register = spyOn(passkeys, 'registerPasskey').mockReturnValue(pending.promise)
    const { result } = renderStep(null)
    let first!: Promise<void>
    act(() => {
      first = result.current.register()
      void result.current.register()
    })
    expect(register).toHaveBeenCalledTimes(1)
    await act(async () => {
      pending.reject(Object.assign(new Error('cancelled'), { name: 'NotAllowedError' }))
      await first
    })
    expect(result.current.status).toBe('idle')
  })

  it('shows an error when registration fails', async () => {
    const { result } = renderStep({ status: 500, message: 'boom' })

    await act(() => result.current.register())

    expect(result.current.status).toBe('error')
  })

  it('goes back to idle when the user dismisses the prompt', async () => {
    const dismissed = Object.assign(new Error('dismissed'), { name: 'NotAllowedError' })
    const { result } = renderStep(dismissed)

    await act(() => result.current.register())

    expect(result.current.status).toBe('idle')
  })
})
