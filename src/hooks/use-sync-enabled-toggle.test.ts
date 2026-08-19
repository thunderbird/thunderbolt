/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import 'fake-indexeddb/auto'
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'

const mockSetSyncEnabled = mock(() => Promise.resolve())
const mockTrackEvent = mock(() => {})

// Partial mock: spread the REAL module so every other export (incl. reconnectSync,
// which sidebar-footer.tsx consumes for real) survives if this registration
// leaks across files under `--randomize`. Only `setSyncEnabled` is overridden with
// the local spy this suite asserts on — the real one disconnects PowerSync.
const realPowersync = await import('@/db/powersync/sync-state')
mock.module('@/db/powersync/sync-state', () => ({
  ...realPowersync,
  setSyncEnabled: mockSetSyncEnabled,
}))

// Spread the REAL modules so every untouched export survives if these
// registrations leak across files under `--randomize`; only the symbols this
// suite drives are overridden.
const realPosthog = await import('@/lib/posthog')
mock.module('@/lib/posthog', () => ({
  ...realPosthog,
  trackEvent: mockTrackEvent,
}))

// The encryption barrel is deliberately NOT mocked: `needsSyncSetupWizard()`
// answers from a real IndexedDB keyring below, which is both closer to
// production and safe to run alongside every other suite.
import { clearAllKeys, generateAK, storeAK, storeDEK } from '@/crypto'
import { beginEncryptionInit, endEncryptionInit } from '@/db/encryption'
import { resetEncryptionInitGate } from '@/db/encryption/init-gate'
import { useLocalSettingsStore } from '@/stores/local-settings-store'
import { disableSyncIfSetupIncomplete, useSyncEnabledToggle } from './use-sync-enabled-toggle'

/** Give this device a complete v2 key hierarchy, so no setup wizard is needed. */
const stageKeyring = async () => {
  await storeAK(await generateAK())
  await storeDEK('0', 'wrapped-blob')
}

const setSyncPreference = (enabled: boolean) => useLocalSettingsStore.getState().setLocalSetting('syncEnabled', enabled)

describe('useSyncEnabledToggle', () => {
  beforeEach(async () => {
    mockSetSyncEnabled.mockClear()
    mockTrackEvent.mockClear()
    resetEncryptionInitGate()
    await clearAllKeys()
  })

  afterEach(() => {
    mockSetSyncEnabled.mockRestore?.()
    mockTrackEvent.mockRestore?.()
    // `useLocalSettingsStore` is persisted and shared, so a leaked `syncEnabled:
    // true` makes the mount effect fire in unrelated tests — in this file and,
    // under --randomize, in others.
    setSyncPreference(false)
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

  describe('disableSyncIfSetupIncomplete', () => {
    it('disables sync when it is on but this device has no key hierarchy', async () => {
      setSyncPreference(true)

      expect(await disableSyncIfSetupIncomplete()).toBe(true)
      expect(mockSetSyncEnabled).toHaveBeenCalledWith(false)
    })

    it('leaves sync alone once the key hierarchy is present', async () => {
      setSyncPreference(true)
      await stageKeyring()

      expect(await disableSyncIfSetupIncomplete()).toBe(false)
      expect(mockSetSyncEnabled).not.toHaveBeenCalled()
    })

    it('does nothing when sync is already off', async () => {
      setSyncPreference(false)

      expect(await disableSyncIfSetupIncomplete()).toBe(false)
      expect(mockSetSyncEnabled).not.toHaveBeenCalled()
    })

    it('waits for the boot-time migration verdict before disabling sync', async () => {
      setSyncPreference(true)
      beginEncryptionInit()

      const pending = disableSyncIfSetupIncomplete()
      // Migration completes while the check is parked on the gate.
      await stageKeyring()
      endEncryptionInit()

      expect(await pending).toBe(false)
      expect(mockSetSyncEnabled).not.toHaveBeenCalled()
    })
  })
})
