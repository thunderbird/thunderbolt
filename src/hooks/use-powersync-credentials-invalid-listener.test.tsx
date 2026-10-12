/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { getDevice } from '@/dal'
import { resetTestDatabase, setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { powersyncCredentialsInvalid } from '@/db/powersync/connector'
import { devicesTable } from '@/db/tables'
import { getAuthToken, setAuthToken } from '@/lib/auth-token'
import { createClient } from '@/lib/http'
import { createQueryTestWrapper } from '@/test-utils/react-query'
import { getClock } from '@/testing-library'
import { eq } from 'drizzle-orm'
import { act, renderHook } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test'
import { showSignInModalEvent, signInSuccessEvent } from './use-credential-events'
import { usePowerSyncCredentialsInvalidListener } from './use-powersync-credentials-invalid-listener'
import { getDb } from '@/db/database'

const deviceId = 'test-device-id'
const authToken = 'test-auth-token'

const mockClearLocalData = mock(() => Promise.resolve())

// Partial mock: spread the REAL module so every other export (getPowerSyncInstance,
// reconnectSync, syncEnabledChangeEvent, isSyncEnabled) is preserved and can't break
// dependents if this registration leaks across files under `--randomize`. Only
// `setSyncEnabled` is overridden with a local spy the suite asserts on.
// See docs/internals/development/testing.md §65 and the sibling spread-mocks in use-pending-device-notification.test.tsx.
const realPowersync = await import('@/db/powersync/sync-state')
const mockSetSyncEnabled = mock(() => Promise.resolve())
mock.module('@/db/powersync/sync-state', () => ({
  ...realPowersync,
  setSyncEnabled: mockSetSyncEnabled,
}))

// No createTestProvider here: its AuthProvider mounts a second copy of this hook with the real
// clearLocalData, which can call window.location.replace after its test has ended.
describe('usePowerSyncCredentialsInvalidListener', () => {
  let mockReplace: ReturnType<typeof spyOn>

  beforeAll(async () => {
    await setupTestDatabase()
    mockReplace = spyOn(window.location, 'replace').mockImplementation(() => undefined)
  })

  afterAll(async () => {
    mockReplace.mockRestore()
    await teardownTestDatabase()
  })

  beforeEach(async () => {
    await resetTestDatabase()
    mockReplace.mockClear()
    mockClearLocalData.mockClear()
    localStorage.clear()
  })

  // Mirror the beforeEach cleanup so the last test's auth token can't leak into
  // the next test file (AuthProvider's mount effect fires get-session on any token).
  afterEach(() => {
    localStorage.clear()
  })

  const setupAuthAndDevice = async (deviceOverrides?: { revokedAt?: string | null }) => {
    localStorage.setItem('thunderbolt_device_id', deviceId)
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
        wrapper: createQueryTestWrapper(),
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

    it('clears local data and redirects to /device-revoked when reason is device_revoked', async () => {
      renderHook(() => usePowerSyncCredentialsInvalidListener({ clearLocalData: mockClearLocalData }), {
        wrapper: createQueryTestWrapper(),
      })

      act(() => {
        dispatchCredentialsInvalid('device_revoked')
      })

      await act(async () => {
        await getClock().runAllAsync()
      })

      expect(mockClearLocalData).toHaveBeenCalledTimes(1)
      expect(mockReplace).toHaveBeenCalledWith('/device-revoked')
    })

    it('redirects to / when reason is device_id_taken', async () => {
      renderHook(() => usePowerSyncCredentialsInvalidListener({ clearLocalData: mockClearLocalData }), {
        wrapper: createQueryTestWrapper(),
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
        wrapper: createQueryTestWrapper(),
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
        wrapper: createQueryTestWrapper(),
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

    it('asks the session check once on session_expired, so a revoked device can still find out', async () => {
      const requestedUrls: string[] = []
      const httpClient = createClient({
        prefixUrl: 'http://test-api.local',
        fetch: async (input) => {
          requestedUrls.push(input instanceof Request ? input.url : String(input))
          return new Response('null', { status: 200, headers: { 'Content-Type': 'application/json' } })
        },
      })

      renderHook(() => usePowerSyncCredentialsInvalidListener({ clearLocalData: mockClearLocalData }), {
        wrapper: createQueryTestWrapper({ httpClient }),
      })

      act(() => {
        dispatchCredentialsInvalid('session_expired')
      })
      await act(async () => {
        await getClock().runAllAsync()
      })

      expect(requestedUrls).toEqual(['http://test-api.local/api/auth/get-session'])
    })

    it('does not re-dispatch showSignInModalEvent for repeated session_expired events', () => {
      setAuthToken(authToken)
      const signInModalListener = mock()
      window.addEventListener(showSignInModalEvent, signInModalListener)

      renderHook(() => usePowerSyncCredentialsInvalidListener({ clearLocalData: mockClearLocalData }), {
        wrapper: createQueryTestWrapper(),
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
        wrapper: createQueryTestWrapper(),
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
      window.addEventListener(showSignInModalEvent, signInModalListener)

      renderHook(() => usePowerSyncCredentialsInvalidListener({ clearLocalData: mockClearLocalData }), {
        wrapper: createQueryTestWrapper(),
      })

      act(() => {
        dispatchCredentialsInvalid('device_revoked')
        dispatchCredentialsInvalid('session_expired')
      })

      expect(signInModalListener).not.toHaveBeenCalled()
      expect(getAuthToken()).toBe(authToken)

      window.removeEventListener(showSignInModalEvent, signInModalListener)
    })

    it("calls setSyncEnabled(false) when reason is 'sync_not_permitted' and does NOT clear data or dispatch modals", () => {
      setAuthToken(authToken)
      const signInModalListener = mock()
      window.addEventListener(showSignInModalEvent, signInModalListener)
      mockSetSyncEnabled.mockClear()

      renderHook(() => usePowerSyncCredentialsInvalidListener({ clearLocalData: mockClearLocalData }), {
        wrapper: createQueryTestWrapper(),
      })

      act(() => {
        dispatchCredentialsInvalid('sync_not_permitted')
      })

      expect(mockSetSyncEnabled).toHaveBeenCalledWith(false)
      expect(getAuthToken()).toBe(authToken)
      expect(mockClearLocalData).not.toHaveBeenCalled()
      expect(mockReplace).not.toHaveBeenCalled()
      expect(signInModalListener).not.toHaveBeenCalled()

      window.removeEventListener(showSignInModalEvent, signInModalListener)
    })
  })

  describe('device table: revoked', () => {
    it('clears local data and redirects to /device-revoked when device has revokedAt', async () => {
      const revokedAt = new Date().toISOString()
      await setupAuthAndDevice({ revokedAt })

      renderHook(() => usePowerSyncCredentialsInvalidListener({ clearLocalData: mockClearLocalData }), {
        wrapper: createQueryTestWrapper(),
      })

      await act(async () => {
        await getClock().runAllAsync()
      })

      expect(mockClearLocalData).toHaveBeenCalledTimes(1)
      expect(mockReplace).toHaveBeenCalledWith('/device-revoked')
    })
  })

  describe('device table: missing after having device', () => {
    it('redirects to /account-deleted when device disappears after being present', async () => {
      await setupAuthAndDevice()
      const db = getDb()
      const wrapper = createQueryTestWrapper()

      renderHook(() => usePowerSyncCredentialsInvalidListener({ clearLocalData: mockClearLocalData }), { wrapper })

      await act(async () => {
        await getClock().runAllAsync()
      })

      expect(await getDevice(db, deviceId)).not.toBeNull()

      await db.delete(devicesTable).where(eq(devicesTable.id, deviceId))
      await wrapper.queryClient.invalidateQueries({ queryKey: ['devices', deviceId] })

      await act(async () => {
        await getClock().runAllAsync()
      })

      expect(mockReplace).toHaveBeenCalledTimes(1)
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
          wrapper: createQueryTestWrapper(),
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
