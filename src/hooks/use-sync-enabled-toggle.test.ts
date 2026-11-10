/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { act, renderHook } from '@testing-library/react'
import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'

const mockSetSyncEnabled = mock(async (enabled: boolean) => {
  useLocalSettingsStore.setState({ syncEnabled: enabled })
})
const mockTrackEvent = mock(() => {})

// Partial mock: spread the REAL module so every other export (incl. reconnectSync,
// which sidebar-footer.tsx consumes for real) survives if this registration
// leaks across files under `--randomize`. Only `setSyncEnabled` is overridden with
// the local spy this suite asserts on. See docs/internals/development/testing.md §65.
const realPowersync = { ...(await import('@/db/powersync/sync-state')) }
mock.module('@/db/powersync/sync-state', () => ({
  ...realPowersync,
  setSyncEnabled: mockSetSyncEnabled,
}))

// Spread the REAL modules so every untouched export survives if these
// registrations leak across files under `--randomize`; only the symbols this
// suite drives are overridden. See docs/internals/development/testing.md §65.
// Snapshot exports before mock.module replaces their live bindings. Restore
// them below so later startup-telemetry tests exercise the real event buffer.
const realPosthog = { ...(await import('@/lib/posthog')) }
mock.module('@/lib/posthog', () => ({
  ...realPosthog,
  trackEvent: mockTrackEvent,
}))

const mockNeedsSetup = mock(() => Promise.resolve(true))

// Spread into a fresh object: mocking the '@/db/encryption' barrel mutates the
// re-exported '@/db/encryption/config' live bindings in place, so we capture a
// value-copy of both up front and restore them in afterAll — otherwise the
// needsSyncSetupWizard override leaks into config-dependent files
// (config/upload-encoder/key-request-responder tests). See testing.md §65.
const realEncryption = { ...(await import('@/db/encryption')) }
const realEncryptionConfig = { ...(await import('@/db/encryption/config')) }
mock.module('@/db/encryption', () => ({
  ...realEncryption,
  needsSyncSetupWizard: mockNeedsSetup,
}))
afterAll(() => {
  mock.module('@/lib/posthog', () => realPosthog)
  mock.module('@/db/powersync/sync-state', () => realPowersync)
  mock.module('@/db/encryption', () => realEncryption)
  mock.module('@/db/encryption/config', () => realEncryptionConfig)
})

import { useLocalSettingsStore } from '@/stores/local-settings-store'
import { useSyncEnabledToggle } from './use-sync-enabled-toggle'

describe('useSyncEnabledToggle', () => {
  beforeEach(() => {
    mockSetSyncEnabled.mockClear()
    mockTrackEvent.mockClear()
    mockNeedsSetup.mockClear()
    mockNeedsSetup.mockResolvedValue(true)
    useLocalSettingsStore.getState().setLocalSetting('syncEnabled', false)
  })

  it('does not open setup from a superseded enable request', async () => {
    useLocalSettingsStore.getState().setLocalSetting('syncEnabled', false)
    const lookup = Promise.withResolvers<boolean>()
    mockNeedsSetup.mockImplementation(() => lookup.promise)
    const beforeSetup = mock(() => {})
    const { result } = renderHook(() => useSyncEnabledToggle(beforeSetup))
    let enabling: Promise<void>
    act(() => {
      enabling = result.current.handleSyncToggle(true)
    })
    await act(async () => {
      await result.current.handleSyncToggle(false)
    })
    await act(async () => {
      lookup.resolve(true)
      await enabling
    })
    expect(result.current.syncSetupOpen).toBe(false)
    expect(beforeSetup).not.toHaveBeenCalled()
    expect(mockSetSyncEnabled).not.toHaveBeenCalledWith(true)
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

  it('does not enable sync after its settings surface is unmounted', async () => {
    useLocalSettingsStore.getState().setLocalSetting('syncEnabled', false)
    const lookup = Promise.withResolvers<boolean>()
    mockNeedsSetup.mockImplementation(() => lookup.promise)
    const { result, unmount } = renderHook(() => useSyncEnabledToggle())
    const enabling = result.current.handleSyncToggle(true)
    unmount()
    lookup.resolve(false)
    await enabling
    expect(mockSetSyncEnabled).not.toHaveBeenCalledWith(true)
  })

  it('handleSyncToggle(true) opens sync setup modal', async () => {
    const beforeSetup = mock(() => expect(result.current.syncSetupOpen).toBe(false))
    const { result } = renderHook(() => useSyncEnabledToggle(beforeSetup))

    await act(async () => {
      await result.current.handleSyncToggle(true)
    })

    expect(result.current.syncSetupOpen).toBe(true)
    expect(beforeSetup).toHaveBeenCalledTimes(1)
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

  it.each([true, false])('disables legacy sync only when setup is needed: %s', async (needsSetup) => {
    useLocalSettingsStore.getState().setLocalSetting('syncEnabled', true)
    mockNeedsSetup.mockResolvedValue(needsSetup)
    await act(async () => {
      renderHook(useSyncEnabledToggle)
    })
    expect(mockSetSyncEnabled).toHaveBeenCalledTimes(needsSetup ? 1 : 0)
    if (needsSetup) {
      expect(mockSetSyncEnabled).toHaveBeenCalledWith(false)
    }
  })

  it('ignores an abandoned migration probe', async () => {
    useLocalSettingsStore.getState().setLocalSetting('syncEnabled', true)
    const response = Promise.withResolvers<boolean>()
    mockNeedsSetup.mockImplementation(() => response.promise)
    const { unmount } = renderHook(useSyncEnabledToggle)
    unmount()
    await act(async () => {
      response.resolve(true)
    })
    expect(mockSetSyncEnabled).not.toHaveBeenCalled()
  })

  it('enables prepared devices and finishes the setup modal', async () => {
    mockNeedsSetup.mockResolvedValue(false)
    const beforeSetup = mock(() => {})
    const { result } = renderHook(() => useSyncEnabledToggle(beforeSetup))
    await act(async () => result.current.handleSyncToggle(true))
    expect(mockSetSyncEnabled).toHaveBeenCalledWith(true)
    expect(mockTrackEvent).toHaveBeenCalledWith('settings_sync_enabled')
    expect(result.current.syncSetupOpen).toBe(false)
    expect(beforeSetup).not.toHaveBeenCalled()
    act(() => result.current.setSyncSetupOpen(true))
    await act(async () => result.current.handleSyncSetupComplete())
    expect(result.current.syncSetupOpen).toBe(false)
    expect(mockSetSyncEnabled).toHaveBeenCalledTimes(2)
  })
})

it('reads the authoritative sync preference without a duplicate change event', () => {
  useLocalSettingsStore.getState().setLocalSetting('syncEnabled', false)
  const { result } = renderHook(() => useSyncEnabledToggle())
  act(() => useLocalSettingsStore.getState().setLocalSetting('syncEnabled', true))
  expect(result.current.syncEnabled).toBe(true)
  act(() => useLocalSettingsStore.getState().setLocalSetting('syncEnabled', false))
  expect(result.current.syncEnabled).toBe(false)
})

afterEach(() => useLocalSettingsStore.setState({ syncEnabled: false }))

it('reads the authoritative sync preference without a duplicate change event', () => {
  useLocalSettingsStore.getState().setLocalSetting('syncEnabled', false)
  const { result } = renderHook(() => useSyncEnabledToggle())
  act(() => useLocalSettingsStore.getState().setLocalSetting('syncEnabled', true))
  expect(result.current.syncEnabled).toBe(true)
  act(() => useLocalSettingsStore.getState().setLocalSetting('syncEnabled', false))
  expect(result.current.syncEnabled).toBe(false)
})
