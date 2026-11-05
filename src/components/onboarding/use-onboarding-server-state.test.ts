/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { act, renderHook } from '@testing-library/react'
import { afterAll, beforeAll, beforeEach, describe, expect, it, mock } from 'bun:test'
import type { FormEvent } from 'react'
import { setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { thunderboltCloudUrl } from '@/lib/constants'
import { ServerVersionUnsupportedError } from '@/lib/server-connection'
import { useLocalSettingsStore } from '@/stores/local-settings-store'
import { createMockAuthClient } from '@/test-utils/auth-client'
import { createTestProvider } from '@/test-utils/test-provider'
import { useOnboardingServerState } from './use-onboarding-server-state'

describe('useOnboardingServerState', () => {
  beforeAll(setupTestDatabase)
  afterAll(teardownTestDatabase)
  beforeEach(() => {
    useLocalSettingsStore.setState({ cloudUrl: '', localMode: true, serverHasAuthenticated: false, syncEnabled: false })
  })

  it('validates the default Thunderbolt service before showing the waitlist', async () => {
    const connect = mock(async (url: string): Promise<void> => {
      useLocalSettingsStore.setState({ cloudUrl: url })
    })
    const { result } = renderHook(() => useOnboardingServerState(connect), { wrapper: createTestProvider() })

    expect(result.current.showWaitlist).toBe(false)
    const onContinueLocal = mock()
    expect(result.current.selection).toBe('local')
    expect(connect).not.toHaveBeenCalled()
    expect(onContinueLocal).not.toHaveBeenCalled()
    act(() => result.current.selectSetup('cloud'))
    expect(result.current.selection).toBe('cloud')
    expect(connect).not.toHaveBeenCalled()
    await act(async () => result.current.continueSetup(onContinueLocal))

    expect(connect).toHaveBeenCalledWith(thunderboltCloudUrl, undefined, expect.any(AbortSignal))
    expect(result.current.showWaitlist).toBe(true)
    expect(result.current.waitlist.state.status).toBe('idle')
    expect(result.current.error).toBeNull()
    expect(result.current.isConnecting).toBe(false)
  })

  it('keeps setup options after a connection failure and clears the error on a successful retry', async () => {
    const connect = mock(async (_url: string): Promise<void> => {
      throw new Error('Network unavailable')
    })
    const { result } = renderHook(() => useOnboardingServerState(connect), { wrapper: createTestProvider() })

    await act(async () => result.current.connectCloud())

    expect(result.current.showWaitlist).toBe(false)
    expect(result.current.error).toBeTruthy()
    expect(result.current.isConnecting).toBe(false)

    connect.mockImplementation(async (url: string) => {
      useLocalSettingsStore.setState({ cloudUrl: url })
    })
    await act(async () => result.current.connectCloud())

    expect(connect).toHaveBeenCalledTimes(2)
    expect(result.current.showWaitlist).toBe(true)
    expect(result.current.error).toBeNull()
    expect(result.current.isConnecting).toBe(false)
  })

  it('explains when Cloud needs an app update while preserving standalone setup', async () => {
    const connect = mock(async (_url: string) => {
      throw new ServerVersionUnsupportedError()
    })
    const { result } = renderHook(() => useOnboardingServerState(connect), { wrapper: createTestProvider() })

    await act(async () => result.current.connectCloud())

    expect(result.current.showWaitlist).toBe(false)
    expect(result.current.error).toContain('Update Thunderbolt')
    expect(result.current.error).toContain('set up without a server')
    expect(result.current.isConnecting).toBe(false)
  })

  it('returns from email verification to the email form, then forgets the unused Cloud selection', async () => {
    useLocalSettingsStore.setState({ cloudUrl: thunderboltCloudUrl })
    const { result } = renderHook(() => useOnboardingServerState(), {
      wrapper: createTestProvider({ mockResponse: { success: true, challengeToken: 'challenge' } }),
    })
    act(() => result.current.waitlist.actions.setEmail('person@example.com'))
    await act(async () => result.current.waitlist.actions.handleSubmit({ preventDefault: () => {} } as FormEvent))
    expect(result.current.waitlist.state.status).toBe('checkEmail')

    act(() => expect(result.current.goBack()).toBe(true))
    expect(result.current.showWaitlist).toBe(true)
    expect(result.current.waitlist.state.status).toBe('idle')

    act(() => expect(result.current.goBack()).toBe(true))
    expect(result.current.showWaitlist).toBe(false)
    expect(useLocalSettingsStore.getState().cloudUrl).toBe('')
    expect(useLocalSettingsStore.getState().localMode).toBe(true)
    expect(result.current.goBack()).toBe(false)
  })

  it('keeps the server selected while the account check before OTP verification is pending', async () => {
    useLocalSettingsStore.setState({ cloudUrl: thunderboltCloudUrl })
    const pendingSession =
      Promise.withResolvers<Awaited<ReturnType<ReturnType<typeof createMockAuthClient>['getSession']>>>()
    const authClient = createMockAuthClient()
    authClient.getSession = mock(() => pendingSession.promise)
    const { result } = renderHook(() => useOnboardingServerState(), { wrapper: createTestProvider({ authClient }) })
    act(() => {
      void result.current.waitlist.actions.handleOtpComplete('12345678')
    })

    expect(result.current.isBusy).toBe(true)
    expect(result.current.goBack()).toBe(true)
    expect(useLocalSettingsStore.getState().cloudUrl).toBe(thunderboltCloudUrl)

    await act(async () => pendingSession.resolve({ data: null, error: null }))
  })

  it('handles organization Back within the setup step', () => {
    const { result } = renderHook(() => useOnboardingServerState(), { wrapper: createTestProvider() })
    act(() => result.current.setShowServerForm(true))
    expect(result.current.showServerForm).toBe(true)
    act(() => expect(result.current.goBack()).toBe(true))
    expect(result.current.showServerForm).toBe(false)
    expect(result.current.goBack()).toBe(false)
  })
  it('cancels Cloud validation when the setup dialog closes', async () => {
    const pending = Promise.withResolvers<void>()
    const connect = mock((_url: string, _client?: unknown, _signal?: AbortSignal) => pending.promise)
    const { result, unmount } = renderHook(() => useOnboardingServerState(connect), { wrapper: createTestProvider() })
    act(() => result.current.connectCloud())
    unmount()
    expect(connect.mock.calls[0][2]?.aborted).toBe(true)
    await act(async () => pending.reject(new Error('cancelled')))
  })
})
