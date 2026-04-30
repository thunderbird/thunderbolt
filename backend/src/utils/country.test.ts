/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, it, expect } from 'bun:test'
import { resolveCountryCode } from './country'

describe('resolveCountryCode', () => {
  it('should resolve 2-letter country codes', () => {
    expect(resolveCountryCode('BR')).toBe('BR')
    expect(resolveCountryCode('US')).toBe('US')
    expect(resolveCountryCode('GB')).toBe('GB')
    expect(resolveCountryCode('CA')).toBe('CA')
  })

  it('should resolve 3-letter country codes', () => {
    expect(resolveCountryCode('BRA')).toBe('BR')
    expect(resolveCountryCode('USA')).toBe('US')
    expect(resolveCountryCode('GBR')).toBe('GB')
    expect(resolveCountryCode('CAN')).toBe('CA')
  })

  it('should resolve country names (case insensitive)', () => {
    expect(resolveCountryCode('Brazil')).toBe('BR')
    expect(resolveCountryCode('brazil')).toBe('BR')
    expect(resolveCountryCode('BRAZIL')).toBe('BR')
    expect(resolveCountryCode('United States')).toBe('US')
    expect(resolveCountryCode('united states')).toBe('US')
    expect(resolveCountryCode('UNITED STATES')).toBe('US')
  })

  it('should handle multi-word country names', () => {
    expect(resolveCountryCode('United Kingdom')).toBe('GB')
    expect(resolveCountryCode('South Korea')).toBe('KR')
    expect(resolveCountryCode('Saudi Arabia')).toBe('SA')
    expect(resolveCountryCode('New Zealand')).toBe('NZ')
  })

  it('should handle special characters in country names', () => {
    expect(resolveCountryCode('São Tomé and Príncipe')).toBe('ST')
    expect(resolveCountryCode('Ivory Coast')).toBe('CI')
  })

  it('should return null for invalid inputs', () => {
    expect(resolveCountryCode('')).toBe(null)
    expect(resolveCountryCode('   ')).toBe(null)
    expect(resolveCountryCode('Invalid Country')).toBe(null)
    expect(resolveCountryCode('XYZ')).toBe(null) // Invalid 3-letter code
    expect(resolveCountryCode('XX')).toBe(null) // Invalid 2-letter code
  })

  it('should handle edge cases', () => {
    expect(resolveCountryCode(null as any)).toBe(null)
    expect(resolveCountryCode(undefined as any)).toBe(null)
    expect(resolveCountryCode(123 as any)).toBe(null)
  })

  it('should trim whitespace', () => {
    expect(resolveCountryCode('  BR  ')).toBe('BR')
    expect(resolveCountryCode('  Brazil  ')).toBe('BR')
    expect(resolveCountryCode('  BRA  ')).toBe('BR')
  })

  it('should handle various country formats', () => {
    // Test a variety of countries to ensure the mapping works
    expect(resolveCountryCode('Germany')).toBe('DE')
    expect(resolveCountryCode('DE')).toBe('DE')
    expect(resolveCountryCode('DEU')).toBe('DE')

    expect(resolveCountryCode('Japan')).toBe('JP')
    expect(resolveCountryCode('JP')).toBe('JP')
    expect(resolveCountryCode('JPN')).toBe('JP')

    expect(resolveCountryCode('Australia')).toBe('AU')
    expect(resolveCountryCode('AU')).toBe('AU')
    expect(resolveCountryCode('AUS')).toBe('AU')
  })
})
