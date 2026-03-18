import { describe, expect, test } from 'bun:test'
import { bytesEqual, fromBase64, fromHex, toBase64, toHex } from './utils'

describe('toBase64 / fromBase64', () => {
  test('round-trips arbitrary bytes', () => {
    const original = new Uint8Array([0, 1, 127, 128, 255])
    const encoded = toBase64(original)
    const decoded = fromBase64(encoded)
    expect(decoded).toEqual(original)
  })

  test('round-trips empty array', () => {
    const original = new Uint8Array(0)
    expect(fromBase64(toBase64(original))).toEqual(original)
  })

  test('encodes known value', () => {
    const bytes = new TextEncoder().encode('hello')
    expect(toBase64(bytes)).toBe('aGVsbG8=')
  })
})

describe('toHex / fromHex', () => {
  test('round-trips arbitrary bytes', () => {
    const original = new Uint8Array([0, 1, 127, 128, 255])
    const hex = toHex(original)
    expect(hex).toBe('00017f80ff')
    expect(fromHex(hex)).toEqual(original)
  })

  test('round-trips empty array', () => {
    const original = new Uint8Array(0)
    expect(fromHex(toHex(original))).toEqual(original)
  })

  test('produces lowercase hex', () => {
    const bytes = new Uint8Array([171, 205, 239])
    expect(toHex(bytes)).toBe('abcdef')
  })

  test('round-trips 32-byte key', () => {
    const key = crypto.getRandomValues(new Uint8Array(32))
    expect(fromHex(toHex(key))).toEqual(key)
  })
})

describe('bytesEqual', () => {
  test('returns true for equal arrays', () => {
    const a = new Uint8Array([1, 2, 3])
    const b = new Uint8Array([1, 2, 3])
    expect(bytesEqual(a, b)).toBe(true)
  })

  test('returns false for different arrays', () => {
    const a = new Uint8Array([1, 2, 3])
    const b = new Uint8Array([1, 2, 4])
    expect(bytesEqual(a, b)).toBe(false)
  })

  test('returns false for different lengths', () => {
    const a = new Uint8Array([1, 2])
    const b = new Uint8Array([1, 2, 3])
    expect(bytesEqual(a, b)).toBe(false)
  })

  test('returns true for empty arrays', () => {
    expect(bytesEqual(new Uint8Array(0), new Uint8Array(0))).toBe(true)
  })
})
