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
    const newConfig = { someFlag: true }
    useConfigStore.getState().updateConfig(newConfig)

    expect(useConfigStore.getState().config).toEqual({ someFlag: true })
  })

  it('preserves cached config when fetch fails (null scenario)', () => {
    // Simulate a successful fetch that populates the store
    const cachedConfig = { featureEnabled: true }
    useConfigStore.getState().updateConfig(cachedConfig)

    // Simulate a failed fetch — caller would NOT call updateConfig
    const fetchResult = null
    if (fetchResult) {
      useConfigStore.getState().updateConfig(fetchResult)
    }

    // Store retains the cached value
    expect(useConfigStore.getState().config).toEqual({ featureEnabled: true })
  })

  it('replaces entire config on update', () => {
    useConfigStore.getState().updateConfig({ a: 1 })
    useConfigStore.getState().updateConfig({ b: 2 })

    expect(useConfigStore.getState().config).toEqual({ b: 2 })
  })
})
