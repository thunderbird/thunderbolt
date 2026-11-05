/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import '@/testing-library'
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'bun:test'
import { EffortRing } from './effort-ring'

afterEach(cleanup)

describe('effort ring', () => {
  it.each([
    ['none', 0],
    ['off', 0],
    ['minimal', 1],
    ['low', 2],
    ['medium', 3],
    ['high', 4],
    ['xhigh', 5],
    ['max', 6],
  ] as const)('shows the canonical strength for %s even when the model has fewer options', (value, filled) => {
    const { container } = render(<EffortRing value={value} values={[value]} />)
    expect(container.querySelectorAll('circle[stroke-opacity="1"]')).toHaveLength(filled)
    expect(container.querySelectorAll('circle')).toHaveLength(6)
  })

  it('ranks opaque values, including default and the empty string, in the advertised order', () => {
    const values = ['', 'default', 'thorough']
    const { container, rerender } = render(<EffortRing value="" values={values} />)
    expect(container.querySelectorAll('circle[stroke-opacity="1"]')).toHaveLength(2)
    rerender(<EffortRing value="default" values={values} />)
    expect(container.querySelectorAll('circle[stroke-opacity="1"]')).toHaveLength(4)
    rerender(<EffortRing value="thorough" values={values} />)
    expect(container.querySelectorAll('circle[stroke-opacity="1"]')).toHaveLength(6)
  })

  it.each([undefined, 'removed'])('does not imply a selected strength for %s', (value) => {
    const { container } = render(<EffortRing value={value} values={['low', 'high']} />)
    expect(container.querySelectorAll('circle[stroke-opacity]')).toHaveLength(0)
    expect(container.querySelector('.lucide-sparkles')).not.toBeNull()
  })
})
