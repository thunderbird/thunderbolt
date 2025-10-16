import { describe, expect, it } from 'bun:test'
import { convertTemperature } from './weather-forecast'

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
