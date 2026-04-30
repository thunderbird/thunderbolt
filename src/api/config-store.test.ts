/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { useConfigStore } from './config-store'

const storageKey = 'thunderbolt-config'

const resetStore = () => {
  useConfigStore.setState({ config: {} })
  localStorage.removeItem(storageKey)
}

describe('config store', () => {
  beforeEach(resetStore)
  afterEach(resetStore)

  it('has empty config as initial state', () => {
    const { config } = useConfigStore.getState()
    expect(config).toEqual({})
  })

  it('updates config via updateConfig', () => {
    useConfigStore.getState().updateConfig({ e2eeEnabled: true })

    expect(useConfigStore.getState().config).toEqual({ e2eeEnabled: true })
  })

  it('preserves cached config when fetch fails (null scenario)', () => {
    // Simulate a successful fetch that populates the store
    useConfigStore.getState().updateConfig({ e2eeEnabled: true })

    // Simulate a failed fetch — caller would NOT call updateConfig
    const fetchResult = null
    if (fetchResult) {
      useConfigStore.getState().updateConfig(fetchResult)
    }

    // Store retains the cached value
    expect(useConfigStore.getState().config).toEqual({ e2eeEnabled: true })
  })

  it('replaces entire config on update', () => {
    useConfigStore.getState().updateConfig({ e2eeEnabled: true })
    useConfigStore.getState().updateConfig({ e2eeEnabled: false })

    expect(useConfigStore.getState().config).toEqual({ e2eeEnabled: false })
  })
})
