import { describe, expect, it } from 'bun:test'
import { getDefaultDataCollectionValue } from './settings'

describe('getDefaultDataCollectionValue', () => {
  it('returns false for oidc mode (self-hosted)', () => {
    expect(getDefaultDataCollectionValue('oidc')).toBe(false)
  })

  it('returns true for consumer mode', () => {
    expect(getDefaultDataCollectionValue('consumer')).toBe(true)
  })

  it('defaults to true when mode is missing', () => {
    expect(getDefaultDataCollectionValue()).toBe(true)
  })
})
