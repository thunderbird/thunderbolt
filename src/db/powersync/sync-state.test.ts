/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { useLocalSettingsStore } from '@/stores/local-settings-store'
import { isSyncEnabled, setSyncEnabled, waitForSyncCatchUp } from './sync-state'

const originalSettings = useLocalSettingsStore.getState()
afterEach(() => useLocalSettingsStore.setState(originalSettings))

it('ignores a stale sync preference without a server', () => {
  useLocalSettingsStore.setState({ cloudUrl: '', syncEnabled: true })
  expect(isSyncEnabled()).toBe(false)
})

it('requires server selection before enabling sync', async () => {
  useLocalSettingsStore.setState({ cloudUrl: '', syncEnabled: false })
  await expect(setSyncEnabled(true)).rejects.toThrow('Select a Thunderbolt server')
  expect(useLocalSettingsStore.getState().syncEnabled).toBe(false)
})

type Predicate = (status: { lastSyncedAt: Date | undefined }) => boolean

/** The status fields `waitForSyncCatchUp` reads, recording the predicate it waits on. */
const createPowerSync = (connected: boolean, downloading: boolean) => {
  const waits: Predicate[] = []
  return {
    waits,
    powerSync: {
      currentStatus: { connected, dataFlowStatus: { downloading, uploading: false } },
      waitForStatus: async (predicate: Predicate) => {
        waits.push(predicate)
      },
    },
  }
}

describe('waitForSyncCatchUp', () => {
  beforeEach(() => {
    useLocalSettingsStore.setState({ cloudUrl: 'https://cloud.example.com/v1', syncEnabled: true })
  })

  it('does not wait when the device is connected and nothing is downloading', () => {
    const { powerSync } = createPowerSync(true, false)
    expect(waitForSyncCatchUp(powerSync)).toBeNull()
  })

  it('does not wait when sync is off', () => {
    useLocalSettingsStore.getState().setLocalSetting('syncEnabled', false)
    const { powerSync } = createPowerSync(false, false)
    expect(waitForSyncCatchUp(powerSync)).toBeNull()
  })

  it.each([
    ['mid-download', true, true],
    ['not connected yet', false, false],
  ])('waits for a sync that completes after the call when the device is %s', (_, connected, downloading) => {
    const { powerSync, waits } = createPowerSync(connected, downloading)

    expect(waitForSyncCatchUp(powerSync)).not.toBeNull()

    const [predicate] = waits
    expect(predicate({ lastSyncedAt: new Date(Date.now() - 1) })).toBe(false)
    expect(predicate({ lastSyncedAt: new Date(Date.now() + 1) })).toBe(true)
    expect(predicate({ lastSyncedAt: undefined })).toBe(false)
  })
})
