/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { lockToVerticalAxis } from './dnd'

describe('lockToVerticalAxis', () => {
  it('removes horizontal movement while preserving vertical movement and scale', () => {
    const result = lockToVerticalAxis({
      transform: { x: 42, y: 18, scaleX: 0.9, scaleY: 0.95 },
    } as Parameters<typeof lockToVerticalAxis>[0])

    expect(result).toEqual({ x: 0, y: 18, scaleX: 0.9, scaleY: 0.95 })
  })
})
