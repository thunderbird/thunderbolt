/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import {
  selectAllowCustomAgents,
  selectBuiltInAgentEnabled,
  selectCloudRunnerWsUrl,
  useConfigStore,
} from './config-store'

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

  it('drops the runner endpoint when a later response omits it', () => {
    // A deployment that turns its runner off must stop placing turns there,
    // even though the previous response is what localStorage still holds.
    useConfigStore.getState().updateConfig({ cloudRunner: { wsUrl: 'wss://runner.test/ws' } })
    useConfigStore.getState().updateConfig({ e2eeEnabled: true })

    expect(selectCloudRunnerWsUrl(useConfigStore.getState().config)).toBeNull()
  })
})

describe('selectBuiltInAgentEnabled', () => {
  it('defaults to enabled when the flag is absent (offline/standalone)', () => {
    expect(selectBuiltInAgentEnabled({})).toBe(true)
  })

  it('is enabled when explicitly true', () => {
    expect(selectBuiltInAgentEnabled({ builtInAgentEnabled: true })).toBe(true)
  })

  it('is disabled only when explicitly false', () => {
    expect(selectBuiltInAgentEnabled({ builtInAgentEnabled: false })).toBe(false)
  })
})

describe('selectAllowCustomAgents', () => {
  it('defaults to allowed when the flag is absent', () => {
    expect(selectAllowCustomAgents({})).toBe(true)
  })

  it('is forbidden only when explicitly false', () => {
    expect(selectAllowCustomAgents({ allowCustomAgents: false })).toBe(false)
  })
})

describe('selectCloudRunnerWsUrl', () => {
  it('is null when the deployment runs no runner', () => {
    expect(selectCloudRunnerWsUrl({})).toBeNull()
  })

  it('returns the configured endpoint', () => {
    expect(selectCloudRunnerWsUrl({ cloudRunner: { wsUrl: 'wss://runner.test/ws' } })).toBe('wss://runner.test/ws')
  })

  it('treats a blank endpoint as absent', () => {
    expect(selectCloudRunnerWsUrl({ cloudRunner: { wsUrl: '   ' } })).toBeNull()
  })
})
