/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterEach, expect, it } from 'bun:test'
import { useLocalSettingsStore } from '@/stores/local-settings-store'
import { isSyncEnabled, setSyncEnabled } from './sync-state'

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
