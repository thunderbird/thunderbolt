/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useConfigStore } from '@/api/config-store'
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'

const mockSetSyncEnabled = mock(() => Promise.resolve())
const mockTrackEvent = mock(() => {})

// Partial mock: spread the REAL module so every other export (incl. reconnectSync,
// which sidebar-footer.tsx consumes for real) survives if this registration
// leaks across files under `--randomize`. Only `setSyncEnabled` is overridden with
// the local spy this suite asserts on. See docs/development/testing.md §65.
const realPowersync = await import('@/db/powersync/sync-state')
mock.module('@/db/powersync/sync-state', () => ({
  ...realPowersync,
  setSyncEnabled: mockSetSyncEnabled,
}))

// Spread the REAL modules so every untouched export survives if these
// registrations leak across files under `--randomize`; only the symbols this
// suite drives are overridden. See docs/development/testing.md §65.
const realPosthog = await import('@/lib/posthog')
mock.module('@/lib/posthog', () => ({
  ...realPosthog,
  trackEvent: mockTrackEvent,
}))

const mockGetCK = mock(() => Promise.resolve(null))

// Both overrides are gated on the real config store (seeded per test below) so
// a leaked registration under `--randomize` mirrors the real module's semantics
// once other files reset the store — never a constant `() => true`.
const encryptionEnabledViaStore = () => useConfigStore.getState().config.e2eeEnabled === true
const realEncryption = await import('@/db/encryption')
mock.module('@/db/encryption', () => ({
  ...realEncryption,
  isEncryptionEnabled: encryptionEnabledViaStore,
  needsSyncSetupWizard: async () => encryptionEnabledViaStore() && !(await mockGetCK()),
}))

const realKeyStorage = await import('@/crypto/key-storage')
mock.module('@/crypto/key-storage', () => ({
  ...realKeyStorage,
  getCK: mockGetCK,
}))

import { useSyncEnabledToggle } from './use-sync-enabled-toggle'

describe('useSyncEnabledToggle', () => {
  beforeEach(() => {
    mockSetSyncEnabled.mockClear()
    mockTrackEvent.mockClear()
    mockGetCK.mockClear()
    mockGetCK.mockImplementation(() => Promise.resolve(null))
    useConfigStore.setState({ config: { e2eeEnabled: true } })
  })

  afterEach(() => {
    mockSetSyncEnabled.mockRestore?.()
    mockTrackEvent.mockRestore?.()
    mockGetCK.mockRestore?.()
    useConfigStore.setState({ config: {} })
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
