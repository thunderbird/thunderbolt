/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { getDevice } from '@/dal'
import { resetTestDatabase, setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { powersyncCredentialsInvalid } from '@/db/powersync/connector'
import { devicesTable } from '@/db/tables'
import { getAuthToken, setAuthToken } from '@/lib/auth-token'
import { createTestProvider } from '@/test-utils/test-provider'
import { getClock, testServerId } from '@/testing-library'
import { useTrustDomainRegistry } from '@/stores/trust-domain-registry'

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { eq } from 'drizzle-orm'
import { type ReactNode } from 'react'
import { act, renderHook } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test'
import { AuthProvider, DatabaseProvider, HttpClientProvider } from '@/contexts'
import { createMockAuthClient } from '@/test-utils/auth-client'
import { createMockHttpClient } from '@/test-utils/http-client'
import { PowerSyncMockProvider } from '@/test-utils/powersync-mock'
import { showRevokedDeviceModalEvent, showSignInModalEvent, signInSuccessEvent } from './use-credential-events'
import { usePowerSyncCredentialsInvalidListener } from './use-powersync-credentials-invalid-listener'
import { getDb } from '@/db/database'

const deviceId = 'test-device-id'
const authToken = 'test-auth-token'

const mockReplace = mock()
const mockClearLocalData = mock(() => Promise.resolve())

// Partial mock: spread the REAL module so every other export (getPowerSyncInstance,
// reconnectSync, syncEnabledChangeEvent, isSyncEnabled) is preserved and can't break
// dependents if this registration leaks across files under `--randomize`. Only
// `setSyncEnabled` is overridden with a local spy the suite asserts on.
// See docs/development/testing.md §65 and the sibling spread-mocks in use-pending-device-notification.test.tsx.
const realPowersync = await import('@/db/powersync/sync-state')
const mockSetSyncEnabled = mock(() => Promise.resolve())
mock.module('@/db/powersync/sync-state', () => ({
  ...realPowersync,
  setSyncEnabled: mockSetSyncEnabled,
}))

describe('usePowerSyncCredentialsInvalidListener', () => {
  beforeAll(async () => {
    await setupTestDatabase()
  })

  afterAll(async () => {
    await teardownTestDatabase()
  })

  const originalLocation = window.location

  beforeEach(async () => {
    await resetTestDatabase()
    mockReplace.mockClear()
    mockClearLocalData.mockClear()
    Object.defineProperty(window, 'location', {
      value: { ...originalLocation, replace: mockReplace },
      writable: true,
      configurable: true,
    })
    localStorage.clear()
    // Re-seed after localStorage.clear() — clearing localStorage can cause Zustand's
    // persist middleware to rehydrate with empty state, losing the active server.
    useTrustDomainRegistry.setState({
      servers: { [testServerId]: { serverId: testServerId, cloudUrl: 'http://localhost' } },
      activeTrustDomain: { kind: 'server', serverId: testServerId },
    })
  })

  afterEach(() => {
    localStorage.clear()
    Object.defineProperty(window, 'location', {
      value: originalLocation,
      writable: true,
      configurable: true,
    })
  })

  const setupAuthAndDevice = async (deviceOverrides?: { revokedAt?: string | null }) => {
    localStorage.setItem(`thunderbolt_device_id__${testServerId}`, deviceId)
    setAuthToken(authToken)

    const db = getDb()
    const now = new Date().toISOString()
    await db.insert(devicesTable).values({
      id: deviceId,
      userId: 'user-1',
      name: 'Test Device',
      lastSeen: now,
      createdAt: now,
      revokedAt: deviceOverrides?.revokedAt ?? null,
    })
  }

  const dispatchCredentialsInvalid = (
    reason:
      | 'account_deleted'
      | 'device_revoked'
      | 'device_id_taken'
      | 'device_id_required'
      | 'session_expired'
      | 'sync_not_permitted',
  ) => {
    window.dispatchEvent(new CustomEvent(powersyncCredentialsInvalid, { detail: { reason } }))
  }

  describe('event-driven: powersyncCredentialsInvalid', () => {
    it('redirects to /account-deleted when reason is account_deleted', async () => {
      renderHook(() => usePowerSyncCredentialsInvalidListener({ clearLocalData: mockClearLocalData }), {
        wrapper: createTestProvider(),
      })

      act(() => {
        dispatchCredentialsInvalid('account_deleted')
      })

      await act(async () => {
        await getClock().runAllAsync()
      })

      expect(mockClearLocalData).toHaveBeenCalled()
      expect(mockReplace).toHaveBeenCalledWith('/account-deleted')
    })

    it('dispatches showRevokedDeviceModalEvent when reason is device_revoked', () => {
      const revokedModalListener = mock()
      window.addEventListener(showRevokedDeviceModalEvent, revokedModalListener)

      renderHook(() => usePowerSyncCredentialsInvalidListener({ clearLocalData: mockClearLocalData }), {
        wrapper: createTestProvider(),
      })

      act(() => {
        dispatchCredentialsInvalid('device_revoked')
      })

      expect(revokedModalListener).toHaveBeenCalled()
      expect(mockReplace).not.toHaveBeenCalled()

      window.removeEventListener(showRevokedDeviceModalEvent, revokedModalListener)
    })

    it('redirects to / when reason is device_id_taken', async () => {
      renderHook(() => usePowerSyncCredentialsInvalidListener({ clearLocalData: mockClearLocalData }), {
        wrapper: createTestProvider(),
      })

      act(() => {
        dispatchCredentialsInvalid('device_id_taken')
      })

      await act(async () => {
        await getClock().runAllAsync()
      })

      expect(mockReplace).toHaveBeenCalledWith('/')
    })

    it('redirects to / when reason is device_id_required', async () => {
      renderHook(() => usePowerSyncCredentialsInvalidListener({ clearLocalData: mockClearLocalData }), {
        wrapper: createTestProvider(),
      })

      act(() => {
        dispatchCredentialsInvalid('device_id_required')
      })

      await act(async () => {
        await getClock().runAllAsync()
      })

      expect(mockReplace).toHaveBeenCalledWith('/')
    })

    it('dispatches showSignInModalEvent and clears auth token when reason is session_expired', () => {
      setAuthToken(authToken)
      const signInModalListener = mock()
      window.addEventListener(showSignInModalEvent, signInModalListener)

      renderHook(() => usePowerSyncCredentialsInvalidListener({ clearLocalData: mockClearLocalData }), {
        wrapper: createTestProvider(),
      })

      act(() => {
        dispatchCredentialsInvalid('session_expired')
      })

      expect(signInModalListener).toHaveBeenCalled()
      expect(getAuthToken()).toBeNull()
      expect(mockClearLocalData).not.toHaveBeenCalled()
      expect(mockReplace).not.toHaveBeenCalled()

      window.removeEventListener(showSignInModalEvent, signInModalListener)
    })

    it('does not re-dispatch showSignInModalEvent for repeated session_expired events', () => {
      setAuthToken(authToken)
      const signInModalListener = mock()
      window.addEventListener(showSignInModalEvent, signInModalListener)

      renderHook(() => usePowerSyncCredentialsInvalidListener({ clearLocalData: mockClearLocalData }), {
        wrapper: createTestProvider(),
      })

      act(() => {
        dispatchCredentialsInvalid('session_expired')
      })
      const callCountAfterFirst = signInModalListener.mock.calls.length

      act(() => {
        dispatchCredentialsInvalid('session_expired')
        dispatchCredentialsInvalid('session_expired')
      })

      expect(signInModalListener.mock.calls.length).toBe(callCountAfterFirst)

      window.removeEventListener(showSignInModalEvent, signInModalListener)
    })

    it('re-dispatches showSignInModalEvent after signInSuccess resets the dedup ref', () => {
      setAuthToken(authToken)
      const signInModalListener = mock()
      window.addEventListener(showSignInModalEvent, signInModalListener)

      renderHook(() => usePowerSyncCredentialsInvalidListener({ clearLocalData: mockClearLocalData }), {
        wrapper: createTestProvider(),
      })

      act(() => {
        dispatchCredentialsInvalid('session_expired')
      })
      const callCountAfterFirst = signInModalListener.mock.calls.length

      act(() => {
        window.dispatchEvent(new CustomEvent(signInSuccessEvent))
      })
      setAuthToken(authToken)
      act(() => {
        dispatchCredentialsInvalid('session_expired')
      })

      expect(signInModalListener.mock.calls.length).toBeGreaterThan(callCountAfterFirst)

      window.removeEventListener(showSignInModalEvent, signInModalListener)
    })

    it('does not dispatch showSignInModalEvent when device_revoked has already fired', () => {
      setAuthToken(authToken)
      const signInModalListener = mock()
      const revokedModalListener = mock()
      window.addEventListener(showSignInModalEvent, signInModalListener)
      window.addEventListener(showRevokedDeviceModalEvent, revokedModalListener)

      renderHook(() => usePowerSyncCredentialsInvalidListener({ clearLocalData: mockClearLocalData }), {
        wrapper: createTestProvider(),
      })

      act(() => {
        dispatchCredentialsInvalid('device_revoked')
        dispatchCredentialsInvalid('session_expired')
      })

      expect(revokedModalListener).toHaveBeenCalled()
      expect(signInModalListener).not.toHaveBeenCalled()

      window.removeEventListener(showSignInModalEvent, signInModalListener)
      window.removeEventListener(showRevokedDeviceModalEvent, revokedModalListener)
    })

    it("calls setSyncEnabled(false) when reason is 'sync_not_permitted' and does NOT clear data or dispatch modals", () => {
      setAuthToken(authToken)
      const signInModalListener = mock()
      const revokedModalListener = mock()
      window.addEventListener(showSignInModalEvent, signInModalListener)
      window.addEventListener(showRevokedDeviceModalEvent, revokedModalListener)
      mockSetSyncEnabled.mockClear()

      renderHook(() => usePowerSyncCredentialsInvalidListener({ clearLocalData: mockClearLocalData }), {
        wrapper: createTestProvider(),
      })

      act(() => {
        dispatchCredentialsInvalid('sync_not_permitted')
      })

      expect(mockSetSyncEnabled).toHaveBeenCalledWith(false)
      expect(getAuthToken()).toBe(authToken)
      expect(mockClearLocalData).not.toHaveBeenCalled()
      expect(mockReplace).not.toHaveBeenCalled()
      expect(signInModalListener).not.toHaveBeenCalled()
      expect(revokedModalListener).not.toHaveBeenCalled()

      window.removeEventListener(showSignInModalEvent, signInModalListener)
      window.removeEventListener(showRevokedDeviceModalEvent, revokedModalListener)
    })
  })

  describe('device table: revoked', () => {
    it('dispatches showRevokedDeviceModalEvent when device has revokedAt', async () => {
      const revokedAt = new Date().toISOString()
      await setupAuthAndDevice({ revokedAt })

      const revokedModalListener = mock()
      window.addEventListener(showRevokedDeviceModalEvent, revokedModalListener)

      renderHook(() => usePowerSyncCredentialsInvalidListener({ clearLocalData: mockClearLocalData }), {
        wrapper: createTestProvider(),
      })

      await act(async () => {
        await getClock().runAllAsync()
      })

      expect(revokedModalListener).toHaveBeenCalled()
      expect(mockReplace).not.toHaveBeenCalled()

      window.removeEventListener(showRevokedDeviceModalEvent, revokedModalListener)
    })
  })

  describe('device table: missing after having device', () => {
    it('redirects to /account-deleted when device disappears after being present', async () => {
      await setupAuthAndDevice()
      const db = getDb()

      const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: 0 } },
      })
      const WrapperWithQueryClient = ({ children }: { children: ReactNode }) => (
        <DatabaseProvider db={getDb()}>
          <PowerSyncMockProvider>
            <QueryClientProvider client={queryClient}>
              <HttpClientProvider httpClient={createMockHttpClient([])}>
                <AuthProvider authClient={createMockAuthClient()}>{children}</AuthProvider>
              </HttpClientProvider>
            </QueryClientProvider>
          </PowerSyncMockProvider>
        </DatabaseProvider>
      )

      renderHook(() => usePowerSyncCredentialsInvalidListener({ clearLocalData: mockClearLocalData }), {
        wrapper: WrapperWithQueryClient,
      })

      await act(async () => {
        await getClock().runAllAsync()
      })

      expect(await getDevice(db, deviceId)).not.toBeNull()

      await db.delete(devicesTable).where(eq(devicesTable.id, deviceId))
      await queryClient.invalidateQueries({ queryKey: ['devices', deviceId] })

      await act(async () => {
        await getClock().runAllAsync()
      })

      expect(mockReplace).toHaveBeenCalledWith('/account-deleted')
    })
  })

  describe('cleanup', () => {
    it('removes event listener on unmount', () => {
      const addSpy = spyOn(window, 'addEventListener')
      const removeSpy = spyOn(window, 'removeEventListener')

      const { unmount } = renderHook(
        () => usePowerSyncCredentialsInvalidListener({ clearLocalData: mockClearLocalData }),
        {
          wrapper: createTestProvider(),
        },
      )

      expect(addSpy).toHaveBeenCalledWith(powersyncCredentialsInvalid, expect.any(Function))

      unmount()

      expect(removeSpy).toHaveBeenCalledWith(powersyncCredentialsInvalid, expect.any(Function))

      addSpy.mockRestore()
      removeSpy.mockRestore()
    })
  })
})
