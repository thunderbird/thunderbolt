/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { createCanary, verifyCanary } from './canary'
import { generateCK } from './primitives'

describe('createCanary', () => {
  it('returns canaryIv, canaryCtext, and canarySecret', async () => {
    const ck = await generateCK()
    const canary = await createCanary(ck)
    expect(canary.canaryIv).toBeDefined()
    expect(canary.canaryCtext).toBeDefined()
    expect(canary.canarySecret).toBeDefined()
    expect(typeof canary.canaryIv).toBe('string')
    expect(typeof canary.canaryCtext).toBe('string')
    expect(typeof canary.canarySecret).toBe('string')
    // Secret should be 64 hex chars (32 bytes)
    expect(canary.canarySecret).toMatch(/^[0-9a-f]{64}$/)
  })

  it('generates unique secrets each time', async () => {
    const ck = await generateCK()
    const canary1 = await createCanary(ck)
    const canary2 = await createCanary(ck)
    expect(canary1.canarySecret).not.toBe(canary2.canarySecret)
  })
})

describe('verifyCanary', () => {
  it('returns valid with canarySecret when using correct key', async () => {
    const ck = await generateCK()
    const canary = await createCanary(ck)
    const result = await verifyCanary(ck, canary.canaryIv, canary.canaryCtext)
    expect(result.valid).toBe(true)
    expect(result.canarySecret).toBe(canary.canarySecret)
  })

  it('returns invalid with no secret when using wrong key', async () => {
    const ck1 = await generateCK()
    const ck2 = await generateCK()
    const canary = await createCanary(ck1)
    const result = await verifyCanary(ck2, canary.canaryIv, canary.canaryCtext)
    expect(result.valid).toBe(false)
    expect(result.canarySecret).toBeUndefined()
  })
})
