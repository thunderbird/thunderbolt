import { describe, expect, it } from 'bun:test'
import { createCanary, verifyCanary } from './canary'
import { generateCK } from './primitives'

describe('createCanary', () => {
  it('returns canaryIv and canaryCtext', async () => {
    const ck = await generateCK()
    const canary = await createCanary(ck)
    expect(canary.canaryIv).toBeDefined()
    expect(canary.canaryCtext).toBeDefined()
    expect(typeof canary.canaryIv).toBe('string')
    expect(typeof canary.canaryCtext).toBe('string')
  })
})

describe('verifyCanary', () => {
  it('returns true with the correct key', async () => {
    const ck = await generateCK()
    const canary = await createCanary(ck)
    const result = await verifyCanary(ck, canary.canaryIv, canary.canaryCtext)
    expect(result).toBe(true)
  })

  it('returns false with a wrong key', async () => {
    const ck1 = await generateCK()
    const ck2 = await generateCK()
    const canary = await createCanary(ck1)
    const result = await verifyCanary(ck2, canary.canaryIv, canary.canaryCtext)
    expect(result).toBe(false)
  })
})
