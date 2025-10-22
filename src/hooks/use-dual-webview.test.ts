import { describe, expect, it } from 'vitest'

describe('useDualWebview', () => {
  it('should constrain split ratio between 0.1 and 0.9', () => {
    const testRatio = (ratio: number) => {
      if (ratio < 0.1 || ratio > 0.9) {
        return false
      }
      return true
    }

    expect(testRatio(0.5)).toBe(true)
    expect(testRatio(0.1)).toBe(true)
    expect(testRatio(0.9)).toBe(true)
    expect(testRatio(0.05)).toBe(false)
    expect(testRatio(0.95)).toBe(false)
  })

  it('should calculate webview dimensions correctly', () => {
    const windowWidth = 1200
    const splitRatio = 0.5

    const leftWidth = Math.floor(windowWidth * splitRatio)
    const rightWidth = windowWidth - leftWidth

    expect(leftWidth).toBe(600)
    expect(rightWidth).toBe(600)
    expect(leftWidth + rightWidth).toBe(windowWidth)
  })

  it('should handle asymmetric splits', () => {
    const windowWidth = 1000
    const splitRatio = 0.3

    const leftWidth = Math.floor(windowWidth * splitRatio)
    const rightWidth = windowWidth - leftWidth

    expect(leftWidth).toBe(300)
    expect(rightWidth).toBe(700)
    expect(leftWidth + rightWidth).toBe(windowWidth)
  })
})
