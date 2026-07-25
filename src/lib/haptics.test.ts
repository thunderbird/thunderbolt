/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'

import { shouldTriggerSurfaceHaptic, surfaceHapticDeduplicationMs } from './haptics'

describe('shouldTriggerSurfaceHaptic', () => {
  it('allows a surface haptic when no interaction haptic preceded it', () => {
    expect(shouldTriggerSurfaceHaptic(null, 1_000)).toBe(true)
  })

  it('suppresses a surface haptic during the same UI transition', () => {
    expect(shouldTriggerSurfaceHaptic(1_000, 1_000 + surfaceHapticDeduplicationMs - 1)).toBe(false)
  })

  it('allows a later independent surface haptic', () => {
    expect(shouldTriggerSurfaceHaptic(1_000, 1_000 + surfaceHapticDeduplicationMs)).toBe(true)
  })
})
