import { describe, expect, test } from 'bun:test'
import { createCanary, verifyCanary } from './canary'
import { generateMasterKey } from './primitives'

describe('key canary', () => {
  test('createCanary + verifyCanary with same key returns true', async () => {
    const key = await generateMasterKey()
    const canary = await createCanary(key)
    expect(await verifyCanary(key, canary)).toBe(true)
  })

  test('verifyCanary with different key returns false', async () => {
    const key1 = await generateMasterKey()
    const key2 = await generateMasterKey()
    const canary = await createCanary(key1)
    expect(await verifyCanary(key2, canary)).toBe(false)
  })

  test('verifyCanary with corrupt ciphertext returns false', async () => {
    const key = await generateMasterKey()
    const canary = await createCanary(key)
    const corrupted = { ...canary, ciphertext: 'AAAA' + canary.ciphertext.slice(4) }
    expect(await verifyCanary(key, corrupted)).toBe(false)
  })

  test('canary has correct version field', async () => {
    const key = await generateMasterKey()
    const canary = await createCanary(key)
    expect(canary.version).toBe('v1')
  })

  test('canary is JSON-serialisable', async () => {
    const key = await generateMasterKey()
    const canary = await createCanary(key)
    const json = JSON.stringify(canary)
    const parsed = JSON.parse(json)
    expect(await verifyCanary(key, parsed)).toBe(true)
  })
})
