import { describe, expect, it } from 'bun:test'
import { formatNumber } from './utils'

describe('utils', () => {
  describe('formatNumber', () => {
    it('should format numbers below 1000 as-is', () => {
      expect(formatNumber(0)).toBe('0')
      expect(formatNumber(42)).toBe('42')
      expect(formatNumber(999)).toBe('999')
    })

    it('should format thousands with K suffix', () => {
      expect(formatNumber(1000)).toBe('1K')
      expect(formatNumber(1500)).toBe('1.5K')
      expect(formatNumber(256000)).toBe('256K')
      expect(formatNumber(999999)).toBe('1M')
    })

    it('should format millions with M suffix', () => {
      expect(formatNumber(1000000)).toBe('1M')
      expect(formatNumber(1500000)).toBe('1.5M')
      expect(formatNumber(2560000)).toBe('2.6M')
    })

    it('should format billions with B suffix', () => {
      expect(formatNumber(1000000000)).toBe('1B')
      expect(formatNumber(1500000000)).toBe('1.5B')
      expect(formatNumber(2560000000)).toBe('2.6B')
    })

    it('should handle exact values without decimals', () => {
      expect(formatNumber(2000)).toBe('2K')
      expect(formatNumber(5000000)).toBe('5M')
      expect(formatNumber(3000000000)).toBe('3B')
    })
  })
})
