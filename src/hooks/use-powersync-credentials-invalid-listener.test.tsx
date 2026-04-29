/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { getDevice } from '@/dal'
import { resetTestDatabase, setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { ThunderboltConnector } from '@/db/powersync/connector'
import { powersyncCredentialsInvalid } from '@/db/powersync/connector'
import { devicesTable } from '@/db/tables'
import { setAuthToken } from '@/lib/auth-token'
import { createTestProvider } from '@/test-utils/test-provider'
import { getClock } from '@/testing-library'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { eq } from 'drizzle-orm'
import { type ReactNode } from 'react'
import { act, renderHook } from '@testing-library/react'
import { afterAll, beforeAll, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test'
import { AuthProvider, DatabaseProvider, HttpClientProvider } from '@/contexts'
import { createMockAuthClient } from '@/test-utils/auth-client'
import { createMockHttpClient } from '@/test-utils/http-client'
import { PowerSyncMockProvider } from '@/test-utils/powersync-mock'
import { showRevokedDeviceModalEvent } from './use-credential-events'
import { usePowerSyncCredentialsInvalidListener } from './use-powersync-credentials-invalid-listener'
import { getDb } from '@/db/database'

const deviceId = 'test-device-id'
const authToken = 'test-auth-token'

const mockReplace = mock()
const mockClearLocalData = mock(() => Promise.resolve())

/** Get real event APIs from an untouched iframe — other tests replace window's and never restore */
const getRealEventApis = () => {
  const iframe = document.createElement('iframe')
  document.body.appendChild(iframe)
  const win = iframe.contentWindow!
  const apis = {
    addEventListener: win.addEventListener,
    removeEventListener: win.removeEventListener,
    dispatchEvent: win.dispatchEvent,
  }
  document.body.removeChild(iframe)
  return apis
}

mock.module('@/lib/cleanup', () => ({
  clearLocalData: mockClearLocalData,
}))

mock.module('@/db/powersync', () => ({
  AppSchema: {},
  drizzleSchema: {},
  ThunderboltConnector,
  PowerSyncDatabaseImpl: class {},
  getPowerSyncInstance: () => null,
  isSyncEnabled: () => false,
  setSyncEnabled: mock(() => Promise.resolve()),
  syncEnabledChangeEvent: 'powersync_sync_enabled_change',
}))

describe('usePowerSyncCredentialsInvalidListener', () => {
  beforeAll(async () => {
    await setupTestDatabase()
    const { addEventListener: add, removeEventListener: remove, dispatchEvent: dispatch } = getRealEventApis()
    window.addEventListener = add.bind(window)
    window.removeEventListener = remove.bind(window)
    window.dispatchEvent = dispatch.bind(window)
  })

  afterAll(async () => {
    await teardownTestDatabase()
  })

  beforeEach(async () => {
    await resetTestDatabase()
    mockReplace.mockClear()
    mockClearLocalData.mockClear()
    Object.defineProperty(window, 'location', {
      value: { replace: mockReplace },
      writable: true,
    })
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
    reason: 'account_deleted' | 'device_revoked' | 'device_id_taken' | 'device_id_required',
  ) => {
    window.dispatchEvent(new CustomEvent(powersyncCredentialsInvalid, { detail: { reason } }))
  }

  describe('event-driven: powersyncCredentialsInvalid', () => {
    it('redirects to /account-deleted when reason is account_deleted', async () => {
      renderHook(() => usePowerSyncCredentialsInvalidListener(), {
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

      renderHook(() => usePowerSyncCredentialsInvalidListener(), {
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
      renderHook(() => usePowerSyncCredentialsInvalidListener(), {
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
      renderHook(() => usePowerSyncCredentialsInvalidListener(), {
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
  })

  describe('device table: revoked', () => {
    it('dispatches showRevokedDeviceModalEvent when device has revokedAt', async () => {
      const revokedAt = new Date().toISOString()
      await setupAuthAndDevice({ revokedAt })

      const revokedModalListener = mock()
      window.addEventListener(showRevokedDeviceModalEvent, revokedModalListener)

      renderHook(() => usePowerSyncCredentialsInvalidListener(), {
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

      renderHook(() => usePowerSyncCredentialsInvalidListener(), {
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

      const { unmount } = renderHook(() => usePowerSyncCredentialsInvalidListener(), {
        wrapper: createTestProvider(),
      })

      expect(addSpy).toHaveBeenCalledWith(powersyncCredentialsInvalid, expect.any(Function))

      unmount()

      expect(removeSpy).toHaveBeenCalledWith(powersyncCredentialsInvalid, expect.any(Function))

      addSpy.mockRestore()
      removeSpy.mockRestore()
    })
  })
})
