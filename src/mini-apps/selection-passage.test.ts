/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import type { MiniAppSelectionItem } from '@shared/mini-app-protocol'
import { collapseChipsAbove, toSelectionPassages } from './selection-passage'

const item = (n: number, data?: unknown): MiniAppSelectionItem => ({
  id: `row-${n}`,
  label: `Row ${n}`,
  text: `Contents of row ${n}`,
  ...(data === undefined ? {} : { data }),
})

const many = (count: number) => Array.from({ length: count }, (_, index) => item(index + 1))

describe('toSelectionPassages', () => {
  it('returns nothing for an empty selection', () => {
    expect(toSelectionPassages([])).toEqual([])
  })

  it('keeps one passage per item while there are few of them', () => {
    const passages = toSelectionPassages(many(collapseChipsAbove))
    expect(passages).toHaveLength(collapseChipsAbove)
    expect(passages[0]).toBe('Row 1\nContents of row 1')
  })

  it('collapses to a single passage once there are enough to be noise', () => {
    const passages = toSelectionPassages(many(collapseChipsAbove + 1))
    expect(passages).toHaveLength(1)
    expect(passages[0]).toStartWith(`${collapseChipsAbove + 1} selected items`)
    expect(passages[0]).toContain('Contents of row 4')
  })

  /**
   * The point of `resolveSelection` returning domain objects: an app that hands
   * over structure must get more to the model than one that scrapes text, or
   * there was never a reason to implement the better path.
   */
  it('carries structured data through to the passage', () => {
    const [passage] = toSelectionPassages([item(1, { orderId: 'A-1041', total: 12400 })])
    expect(passage).toContain('"orderId":"A-1041"')
  })

  it('drops a payload too large to be worth the context, keeping the text', () => {
    const [passage] = toSelectionPassages([item(1, { blob: 'x'.repeat(5_000) })])
    expect(passage).toBe('Row 1\nContents of row 1')
  })

  it('survives a cyclic payload rather than losing the whole selection', () => {
    const cyclic: Record<string, unknown> = { name: 'loop' }
    cyclic.self = cyclic

    const passages = toSelectionPassages([item(1, cyclic), item(2)])
    expect(passages).toEqual(['Row 1\nContents of row 1', 'Row 2\nContents of row 2'])
  })

  it('ignores a payload that JSON cannot represent at all', () => {
    const [passage] = toSelectionPassages([item(1, () => 'not serialisable')])
    expect(passage).toBe('Row 1\nContents of row 1')
  })
})
