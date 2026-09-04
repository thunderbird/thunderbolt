/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import type { SurfaceSelectionItem } from './types'
import { toSelectionPassage } from './selection-passage'

const item = (n: number, data?: unknown): SurfaceSelectionItem => ({
  id: `row-${n}`,
  label: `Row ${n}`,
  text: `Contents of row ${n}`,
  ...(data === undefined ? {} : { data }),
})

describe('toSelectionPassage', () => {
  it('joins the label and the text when there is no payload', () => {
    expect(toSelectionPassage(item(1))).toBe('Row 1\nContents of row 1')
  })

  /**
   * The point of the guest returning domain objects: an app that hands over
   * structure must get more to the model than one that scrapes text, or there
   * was never a reason to implement the better path.
   */
  it('carries structured data through to the passage', () => {
    expect(toSelectionPassage(item(1, { orderId: 'A-1041', total: 12400 }))).toContain('"orderId":"A-1041"')
  })

  it('drops a payload too large to be worth the context, keeping the text', () => {
    expect(toSelectionPassage(item(1, { blob: 'x'.repeat(5_000) }))).toBe('Row 1\nContents of row 1')
  })

  it('survives a cyclic payload rather than losing the selection', () => {
    const cyclic: Record<string, unknown> = { name: 'loop' }
    cyclic.self = cyclic

    expect(toSelectionPassage(item(1, cyclic))).toBe('Row 1\nContents of row 1')
  })

  it('ignores a payload that JSON cannot represent at all', () => {
    expect(toSelectionPassage(item(1, () => 'not serialisable'))).toBe('Row 1\nContents of row 1')
  })
})
