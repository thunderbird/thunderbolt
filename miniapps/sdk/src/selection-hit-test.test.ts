/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { elementAtPoint } from './selection-hit-test'

describe('elementAtPoint fallback', () => {
  it('picks a plain div when no preferred ancestor matches', () => {
    document.body.innerHTML = '<div id="card">Revenue up 12%</div>'
    const card = document.getElementById('card')!
    card.getBoundingClientRect = () =>
      ({
        x: 10,
        y: 20,
        width: 100,
        height: 30,
        top: 20,
        left: 10,
        right: 110,
        bottom: 50,
        toJSON: () => ({}),
      }) as DOMRect
    document.elementFromPoint = () => card

    const hit = elementAtPoint({ x: 15, y: 25 })
    expect(hit?.text).toBe('Revenue up 12%')
  })

  it('still prefers a semantic ancestor when there is one', () => {
    document.body.innerHTML = '<table><tbody><tr id="row"><td>A-1</td><td>NVDA</td></tr></tbody></table>'
    const cell = document.querySelector('#row td')!
    const row = document.getElementById('row')!
    row.getBoundingClientRect = () =>
      ({ x: 0, y: 0, width: 200, height: 20, top: 0, left: 0, right: 200, bottom: 20, toJSON: () => ({}) }) as DOMRect
    document.elementFromPoint = () => cell

    const hit = elementAtPoint({ x: 5, y: 5 })
    expect(hit?.text).toContain('NVDA')
  })

  it('returns null when nothing is under the pointer', () => {
    document.elementFromPoint = () => null
    expect(elementAtPoint({ x: 1, y: 1 })).toBeNull()
  })
})
