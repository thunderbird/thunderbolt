import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { ThunderboltConnector } from '@/db/powersync/connector'

const mockSetSyncEnabled = mock(() => Promise.resolve())
const mockTrackEvent = mock(() => {})

mock.module('@/db/powersync', () => ({
  AppSchema: {},
  drizzleSchema: {},
  ThunderboltConnector,
  PowerSyncDatabaseImpl: class {},
  getPowerSyncInstance: () => null,
  isSyncEnabled: () => false,
  setSyncEnabled: mockSetSyncEnabled,
  syncEnabledChangeEvent: 'powersync_sync_enabled_change',
}))

mock.module('@/lib/posthog', () => ({
  trackEvent: mockTrackEvent,
}))

import { useSyncEnabledToggle } from './use-sync-enabled-toggle'

describe('useSyncEnabledToggle', () => {
  beforeEach(() => {
    mockSetSyncEnabled.mockClear()
    mockTrackEvent.mockClear()
  })

  afterEach(() => {
    mockSetSyncEnabled.mockRestore?.()
    mockTrackEvent.mockRestore?.()
  })

  it('returns sync toggle state and handlers', () => {
    const { result } = renderHook(() => useSyncEnabledToggle())

    expect(result.current).toMatchObject({
      syncEnabled: expect.any(Boolean),
      syncSetupOpen: false,
      setSyncSetupOpen: expect.any(Function),
      handleSyncToggle: expect.any(Function),
      handleSyncSetupComplete: expect.any(Function),
    })
  })

  it('handleSyncToggle(true) opens sync setup modal', async () => {
    const { result } = renderHook(() => useSyncEnabledToggle())

    await act(async () => {
      await result.current.handleSyncToggle(true)
    })

    expect(result.current.syncSetupOpen).toBe(true)
  })

  it('handleSyncToggle(false) disables sync and tracks event', async () => {
    const { result } = renderHook(() => useSyncEnabledToggle())

    await act(async () => {
      await result.current.handleSyncToggle(false)
    })

    expect(result.current.syncEnabled).toBe(false)
    expect(mockSetSyncEnabled).toHaveBeenCalledWith(false)
    expect(mockTrackEvent).toHaveBeenCalledWith('settings_sync_disabled')
  })
})
