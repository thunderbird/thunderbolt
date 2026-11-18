/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'bun:test'

import { AutosizeTextarea } from './autosize-textarea'

afterEach(cleanup)

describe('AutosizeTextarea', () => {
  it.each([
    ['no min-height of its own', '', ''],
    ['a min-height of its own', '40px', ''],
    ['an important min-height of its own', '40px', 'important'],
  ])('holds the box around the field while it measures, then gives back %s', (_, ownMinHeight, ownPriority) => {
    const { container, rerender } = render(
      <div>
        <AutosizeTextarea value="one" onChange={() => {}} />
      </div>,
    )
    const textarea = container.querySelector('textarea')!
    const box = textarea.parentElement!
    box.style.setProperty('min-height', ownMinHeight, ownPriority)
    Object.defineProperty(box, 'offsetHeight', { configurable: true, value: 120 })
    const boxMinHeightsWhileMeasuring: string[] = []
    Object.defineProperty(textarea, 'scrollHeight', {
      configurable: true,
      get: () => {
        boxMinHeightsWhileMeasuring.push(box.style.minHeight)
        return 80
      },
    })

    rerender(
      <div>
        <AutosizeTextarea value={'one\ntwo'} onChange={() => {}} />
      </div>,
    )

    expect(boxMinHeightsWhileMeasuring).toEqual(['120px'])
    expect(box.style.getPropertyValue('min-height')).toBe(ownMinHeight)
    expect(box.style.getPropertyPriority('min-height')).toBe(ownPriority)
    expect(textarea.style.height).toBe('86px')
  })
})
