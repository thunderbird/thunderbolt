/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterEach, describe, expect, it, mock } from 'bun:test'
import {
  initialLocalSettings,
  isCurrentServer,
  mergeLocalSettings,
  onServerChangedInOtherTab,
  useLocalSettingsStore,
} from './local-settings-store'

const localDefaults = () => ({
  ...useLocalSettingsStore.getState(),
  cloudUrl: '',
  localMode: true,
  serverHasAuthenticated: false,
})

describe('server selection across windows', () => {
  const settings = useLocalSettingsStore.getState()
  const key = 'thunderbolt-local-settings'
  afterEach(() => useLocalSettingsStore.setState(settings))

  it('checks shared storage before the queued change event arrives', () => {
    useLocalSettingsStore.setState({ cloudUrl: 'https://old.example/v1' })
    localStorage.setItem(key, JSON.stringify({ state: { cloudUrl: 'https://next.example/v1' } }))
    expect(isCurrentServer('https://old.example/v1')).toBe(false)
    expect(isCurrentServer('https://next.example/v1')).toBe(false)
  })

  it('accepts an unpersisted fresh-install default, but not a removed server', () => {
    useLocalSettingsStore.setState(initialLocalSettings)
    localStorage.removeItem(key)
    expect(isCurrentServer(initialLocalSettings.cloudUrl)).toBe(true)
    useLocalSettingsStore.setState({ cloudUrl: 'https://old.example/v1' })
    localStorage.removeItem(key)
    expect(isCurrentServer('https://old.example/v1')).toBe(false)
  })

  it('fails closed for malformed saved settings', () => {
    localStorage.setItem(key, '{')
    expect(isCurrentServer(useLocalSettingsStore.getState().cloudUrl)).toBe(false)
  })

  it('notifies on a different server, but not unrelated preferences, and unsubscribes', () => {
    const listener = mock(() => {})
    const unsubscribe = onServerChangedInOtherTab(listener)
    const event = () => window.dispatchEvent(new StorageEvent('storage', { key, storageArea: localStorage }))
    useLocalSettingsStore.setState({ theme: 'dark' })
    event()
    expect(listener).not.toHaveBeenCalled()
    localStorage.setItem(key, JSON.stringify({ state: { cloudUrl: 'https://next.example/v1' } }))
    event()
    expect(listener).toHaveBeenCalledTimes(1)
    unsubscribe()
    event()
    expect(listener).toHaveBeenCalledTimes(1)
  })
})

describe('local settings hydration', () => {
  it('keeps fresh standalone installs unbound', () => {
    expect(mergeLocalSettings(undefined, localDefaults())).toMatchObject({
      cloudUrl: '',
      localMode: true,
      serverHasAuthenticated: false,
    })
  })

  it('keeps legacy configured installations account-bound even on a new native default', () => {
    expect(mergeLocalSettings({ cloudUrl: 'https://existing.example/v1' }, localDefaults())).toMatchObject({
      cloudUrl: 'https://existing.example/v1',
      localMode: false,
      serverHasAuthenticated: true,
    })
  })

  it('preserves an explicitly unclaimed server and local access across restarts', () => {
    const saved = { cloudUrl: 'https://selected.example/v1', localMode: true, serverHasAuthenticated: false }
    expect(mergeLocalSettings(saved, localDefaults())).toMatchObject(saved)
  })
})
