/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import '@testing-library/jest-dom'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, mock } from 'bun:test'

import { getClock } from '@/testing-library'
import { useLongPress } from './use-long-press'

const Harness = ({ onLongPress }: { onLongPress: () => void }) => {
  const handlers = useLongPress(onLongPress)
  return <div {...handlers}>Long-press target</div>
}

describe('useLongPress', () => {
  it('fires after a sustained touch', () => {
    const onLongPress = mock(() => {})
    render(<Harness onLongPress={onLongPress} />)
    const target = screen.getByText('Long-press target')

    fireEvent.touchStart(target, { touches: [{ clientX: 10, clientY: 10 }] })
    act(() => getClock().tick(500))

    expect(onLongPress).toHaveBeenCalledTimes(1)
  })

  it('cancels the touch timer when a native context menu wins the race', () => {
    const onLongPress = mock(() => {})
    render(<Harness onLongPress={onLongPress} />)
    const target = screen.getByText('Long-press target')

    fireEvent.touchStart(target, { touches: [{ clientX: 10, clientY: 10 }] })
    fireEvent.contextMenu(target)
    act(() => getClock().tick(500))

    expect(onLongPress).toHaveBeenCalledTimes(1)
    fireEvent.contextMenu(target)
    expect(onLongPress).toHaveBeenCalledTimes(2)
  })

  it('does not fire after the operating system cancels the touch', () => {
    const onLongPress = mock(() => {})
    render(<Harness onLongPress={onLongPress} />)
    const target = screen.getByText('Long-press target')

    fireEvent.touchStart(target, { touches: [{ clientX: 10, clientY: 10 }] })
    fireEvent.touchCancel(target)
    act(() => getClock().tick(500))

    expect(onLongPress).not.toHaveBeenCalled()
  })
})
