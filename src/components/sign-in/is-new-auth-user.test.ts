import { describe, expect, test } from 'bun:test'
import { isNewAuthUser } from './use-sign-in-form-state'

describe('isNewAuthUser', () => {
  test('returns true when isNew is true', () => {
    expect(isNewAuthUser({ id: '1', isNew: true })).toBe(true)
  })

  test('returns false when isNew is false', () => {
    expect(isNewAuthUser({ id: '1', isNew: false })).toBe(false)
  })

  test('returns false when isNew is missing', () => {
    expect(isNewAuthUser({ id: '1' })).toBe(false)
  })

  test('returns false for null', () => {
    expect(isNewAuthUser(null)).toBe(false)
  })

  test('returns false for undefined', () => {
    expect(isNewAuthUser(undefined)).toBe(false)
  })

  test('returns false for non-boolean truthy isNew', () => {
    expect(isNewAuthUser({ isNew: 1 })).toBe(false)
    expect(isNewAuthUser({ isNew: 'yes' })).toBe(false)
  })
})
