/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'

const mockSetSyncEnabled = mock(() => Promise.resolve())
const mockTrackEvent = mock(() => {})

// Partial mock: spread the REAL module so every other export (incl. reconnectSync,
// which powersync-status.test.tsx consumes for real) survives if this registration
// leaks across files under `--randomize`. Only `setSyncEnabled` is overridden with
// the local spy this suite asserts on. See docs/development/testing.md §65.
const realPowersync = await import('@/db/powersync')
mock.module('@/db/powersync', () => ({
  ...realPowersync,
  setSyncEnabled: mockSetSyncEnabled,
}))

mock.module('@/lib/posthog', () => ({
  trackEvent: mockTrackEvent,
}))

const mockGetCK = mock(() => Promise.resolve(null))

mock.module('@/db/encryption', () => ({
  isEncryptionEnabled: () => true,
  needsSyncSetupWizard: async () => !(await mockGetCK()),
}))

mock.module('@/crypto/key-storage', () => ({
  getCK: mockGetCK,
}))

import { useSyncEnabledToggle } from './use-sync-enabled-toggle'

describe('useSyncEnabledToggle', () => {
  beforeEach(() => {
    mockSetSyncEnabled.mockClear()
    mockTrackEvent.mockClear()
    mockGetCK.mockClear()
    mockGetCK.mockImplementation(() => Promise.resolve(null))
  })

  afterEach(() => {
    mockSetSyncEnabled.mockRestore?.()
    mockTrackEvent.mockRestore?.()
    mockGetCK.mockRestore?.()
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
