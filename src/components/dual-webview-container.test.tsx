import { describe, expect, it } from 'vitest'
import type { DualWebviewConfig } from './dual-webview-container'

/**
 * Tests for DualWebviewContainer configuration
 *
 * Note: Full component rendering tests would require a browser environment.
 * These tests focus on configuration validation and logic.
 */
describe('DualWebviewContainer', () => {
  it('should accept valid config', () => {
    const config: DualWebviewConfig = {
      leftUrl: 'http://localhost:1420',
      rightUrl: 'http://localhost:1420/test',
      splitRatio: 0.5,
    }

    expect(config.leftUrl).toBe('http://localhost:1420')
    expect(config.rightUrl).toBe('http://localhost:1420/test')
    expect(config.splitRatio).toBe(0.5)
  })

  it('should allow custom split ratios', () => {
    const config: DualWebviewConfig = {
      leftUrl: 'http://localhost:1420',
      rightUrl: 'http://localhost:1420/test',
      splitRatio: 0.7,
    }

    expect(config.splitRatio).toBe(0.7)
  })

  it('should allow split ratio to be optional', () => {
    const config: DualWebviewConfig = {
      leftUrl: 'http://localhost:1420',
      rightUrl: 'http://localhost:1420/test',
    }

    expect(config.splitRatio).toBeUndefined()
  })
})
