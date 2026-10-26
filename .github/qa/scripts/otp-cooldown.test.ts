/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Repro specs sign in through e2e/helpers. A c1 spec that signs out and back in with the same address must wait
// out the backend's 15 s per-address cooldown, or the second code request gets a 429 and the spec times out.
import { describe, expect, test } from 'bun:test'
import { createOtpCooldown } from '../../../e2e/helpers'

describe('createOtpCooldown', () => {
  const setup = () => {
    const clock = { now: 1_000 }
    const slept: number[] = []
    const cooldown = createOtpCooldown(
      () => clock.now,
      async (ms) => {
        slept.push(ms)
      },
    )
    return { clock, slept, cooldown }
  }

  test('a second code for the same address waits until 15 s and a margin have passed since the first', async () => {
    const { clock, slept, cooldown } = setup()
    await cooldown.wait('ada@thunderbolt.test')
    cooldown.requested('ada@thunderbolt.test')
    clock.now += 5_000

    await cooldown.wait('ada@thunderbolt.test')

    expect(slept).toEqual([10_250])
  })

  test('another address, or the same one after the cooldown, asks at once', async () => {
    const { clock, slept, cooldown } = setup()
    cooldown.requested('ada@thunderbolt.test')
    await cooldown.wait('bob@thunderbolt.test')
    clock.now += 16_000

    await cooldown.wait('ada@thunderbolt.test')

    expect(slept).toEqual([])
  })

  test('a request at the clock origin still counts', async () => {
    const { clock, slept, cooldown } = setup()
    clock.now = 0
    cooldown.requested('ada@thunderbolt.test')

    await cooldown.wait('ada@thunderbolt.test')

    expect(slept).toEqual([15_250])
  })
})
