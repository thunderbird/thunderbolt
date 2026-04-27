/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { convertTemperature, getWeatherMetadata } from './lib'

describe('convertTemperature', () => {
  it('should return the same temperature when source and target units are the same', () => {
    expect(convertTemperature(20, 'c', 'c')).toBe(20)
    expect(convertTemperature(68, 'f', 'f')).toBe(68)
  })

  it('should convert from Celsius to Fahrenheit', () => {
    expect(convertTemperature(0, 'c', 'f')).toBe(32)
    expect(convertTemperature(100, 'c', 'f')).toBe(212)
    expect(convertTemperature(20, 'c', 'f')).toBe(68)
    expect(convertTemperature(-40, 'c', 'f')).toBe(-40)
  })

  it('should convert from Fahrenheit to Celsius', () => {
    expect(convertTemperature(32, 'f', 'c')).toBe(0)
    expect(convertTemperature(212, 'f', 'c')).toBe(100)
    expect(convertTemperature(68, 'f', 'c')).toBe(20)
    expect(convertTemperature(-40, 'f', 'c')).toBe(-40)
  })

  it('should round temperatures to nearest integer', () => {
    expect(convertTemperature(25.5, 'c', 'f')).toBe(78) // 77.9 rounds to 78
    expect(convertTemperature(77.9, 'f', 'c')).toBe(26) // 25.5 rounds to 26
  })

  it('should handle bidirectional conversion symmetry', () => {
    const celsiusTemp = 25
    const fahrenheitTemp = convertTemperature(celsiusTemp, 'c', 'f')
    const backToCelsius = convertTemperature(fahrenheitTemp, 'f', 'c')

    // Due to rounding, we might be off by 1 degree
    expect(Math.abs(backToCelsius - celsiusTemp)).toBeLessThanOrEqual(1)
  })
})

describe('getWeatherMetadata', () => {
  it('returns day icon for date-only string', () => {
    const result = getWeatherMetadata(0, '2024-06-15')
    expect(result.icon).toContain('-day')
  })

  it('returns day icon for datetime string during daytime', () => {
    const result = getWeatherMetadata(0, '2024-06-15T12:00:00')
    expect(result.icon).toContain('-day')
  })

  it('returns night icon for datetime string during nighttime', () => {
    const result = getWeatherMetadata(0, '2024-06-15T22:00:00')
    expect(result.icon).toContain('-night')
  })

  it('returns night icon for datetime at early morning hour', () => {
    const result = getWeatherMetadata(1, '2024-06-15T03:00:00')
    expect(result.icon).toContain('-night')
  })

  it('returns day icon at boundary hour 6', () => {
    const result = getWeatherMetadata(0, '2024-06-15T06:00:00')
    expect(result.icon).toContain('-day')
  })

  it('returns night icon at boundary hour 18', () => {
    const result = getWeatherMetadata(0, '2024-06-15T18:00:00')
    expect(result.icon).toContain('-night')
  })

  it('returns correct description for known weather code', () => {
    const result = getWeatherMetadata(0, '2024-06-15')
    expect(result.description).toBe('Clear sky')
  })

  it('returns unknown description for unrecognized weather code', () => {
    const result = getWeatherMetadata(999, '2024-06-15')
    expect(result.description).toBe('Unknown (code 999)')
  })

  it('returns day icon for unknown code with date-only string', () => {
    const result = getWeatherMetadata(999, '2024-06-15')
    expect(result.icon).toContain('-day')
  })

  it('returns night icon for unknown code with nighttime datetime', () => {
    const result = getWeatherMetadata(999, '2024-06-15T23:00:00')
    expect(result.icon).toContain('-night')
  })

  it('returns day icon for all date-only strings across weather codes', () => {
    const codesWithDayNight = [0, 1, 2, 3, 45, 51, 61, 71, 95]
    for (const code of codesWithDayNight) {
      const result = getWeatherMetadata(code, '2024-01-15')
      expect(result.icon).toContain('-day')
    }
  })
})
