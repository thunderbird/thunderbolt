/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'

import { defaultSkills } from './skills'

describe('defaultSkills', () => {
  it('seeds every default with a pinnedOrder so new users start with pinned chips in chat', () => {
    // Regression guard — Chris flagged that seeded skills must be pinned by
    // default. Pinning is now manageable only from the chat composer; a new
    // user with no pinned defaults would see the chip bar empty until they
    // open the `+` popover and pin one manually, which loses the "starter
    // chip is ready" affordance that the legacy automations gave them.
    for (const skill of defaultSkills) {
      expect(typeof skill.pinnedOrder).toBe('number')
      expect(skill.pinnedOrder).not.toBeNull()
    }
  })

  it('assigns each default a unique pinnedOrder so the order is stable on seed', () => {
    const orders = defaultSkills.map((s) => s.pinnedOrder)
    expect(new Set(orders).size).toBe(orders.length)
  })

  it('seeds every default as enabled — disabled defaults would never reach the chat resolver', () => {
    for (const skill of defaultSkills) {
      expect(skill.enabled).toBe(1)
    }
  })
})
