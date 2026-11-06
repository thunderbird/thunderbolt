/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import '@/testing-library'
import { getClock } from '@/testing-library'
import { act, render } from '@testing-library/react'
import { describe, expect, it } from 'bun:test'
import { useAutofocusOnMount } from './use-autofocus-on-mount'

const TestInput = ({ enabled }: { enabled?: boolean }) => {
  const ref = useAutofocusOnMount<HTMLInputElement>(enabled)
  return <input ref={ref} aria-label="target" defaultValue="Existing text" />
}

// The global harness fakes requestAnimationFrame (sinon), so the deferred
// focus fires when the clock advances past one frame.
const flushAnimationFrame = () => {
  act(() => {
    getClock().tick(16)
  })
}

describe('useAutofocusOnMount', () => {
  it('focuses the element one frame after mount', () => {
    const { getByLabelText } = render(<TestInput />)
    const input = getByLabelText('target') as HTMLInputElement

    expect(document.activeElement).not.toBe(input)
    flushAnimationFrame()
    expect(document.activeElement).toBe(input)
    expect(input.selectionStart).toBe(input.value.length)
    expect(input.selectionEnd).toBe(input.value.length)
  })

  it('does not focus when disabled', () => {
    const { getByLabelText } = render(<TestInput enabled={false} />)
    const input = getByLabelText('target')

    flushAnimationFrame()
    expect(document.activeElement).not.toBe(input)
  })
})
