/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import '@testing-library/jest-dom'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, mock } from 'bun:test'
import { ElementPickOverlay } from './element-pick-overlay'

const renderOverlay = () => {
  const onPoint = mock(() => {})
  const onPick = mock(() => {})
  const onSelect = mock(() => {})
  const onCancel = mock(() => {})
  const { container } = render(
    <ElementPickOverlay element={null} onPoint={onPoint} onPick={onPick} onSelect={onSelect} onCancel={onCancel} />,
  )
  return { onPoint, onPick, onSelect, onCancel, captureLayer: container.firstElementChild as HTMLElement }
}

describe('ElementPickOverlay', () => {
  afterEach(() => {
    cleanup()
  })

  it('cancels on Escape', () => {
    const { onCancel } = renderOverlay()

    fireEvent.keyDown(window, { key: 'Escape' })

    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it('commits a pick when a mouse clicks the capture layer', () => {
    const { onPick, onSelect, onCancel, captureLayer } = renderOverlay()

    fireEvent.pointerDown(captureLayer, { pointerType: 'mouse' })
    fireEvent.click(captureLayer)

    expect(onPick).toHaveBeenCalledTimes(1)
    expect(onSelect).not.toHaveBeenCalled()
    expect(onCancel).not.toHaveBeenCalled()
  })

  it('only selects when a touch taps the capture layer', () => {
    const { onPick, onSelect, captureLayer } = renderOverlay()

    fireEvent.pointerDown(captureLayer, { pointerType: 'touch' })
    fireEvent.click(captureLayer)

    expect(onSelect).toHaveBeenCalledTimes(1)
    expect(onPick).not.toHaveBeenCalled()
  })

  it('treats touch movement as something other than hover', () => {
    const { onPoint, captureLayer } = renderOverlay()

    fireEvent.pointerMove(captureLayer, { pointerType: 'touch' })

    expect(onPoint).not.toHaveBeenCalled()
  })
})
