/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Import for side effect: registers the framer-motion `mock.module` so `animate` resolves
// synchronously and `useMotionValue`/`useTransform` return inert values in jsdom.
import '@/test-utils/framer-motion-mock'

import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, mock } from 'bun:test'
import type { PanInfo } from 'framer-motion'
import { useState } from 'react'

import { getClock } from '@/testing-library'
import { MobileSidebar, shouldCloseOnDragEnd } from './mobile-sidebar'

afterEach(() => {
  cleanup()
})

const makeDragInfo = (offsetX: number, velocityX: number): PanInfo => ({
  point: { x: 0, y: 0 },
  delta: { x: 0, y: 0 },
  offset: { x: offsetX, y: 0 },
  velocity: { x: velocityX, y: 0 },
})

describe('shouldCloseOnDragEnd', () => {
  it('closes a left drawer dragged past the -50px threshold', () => {
    expect(shouldCloseOnDragEnd('left', makeDragInfo(-60, 0))).toBe(true)
  })

  it('closes a left drawer flicked left fast enough', () => {
    expect(shouldCloseOnDragEnd('left', makeDragInfo(-10, -600))).toBe(true)
  })

  it('keeps a left drawer open below both thresholds', () => {
    expect(shouldCloseOnDragEnd('left', makeDragInfo(-10, -100))).toBe(false)
  })

  it('closes a right drawer dragged past the +50px threshold', () => {
    expect(shouldCloseOnDragEnd('right', makeDragInfo(60, 0))).toBe(true)
  })

  it('closes a right drawer flicked right fast enough', () => {
    expect(shouldCloseOnDragEnd('right', makeDragInfo(10, 600))).toBe(true)
  })

  it('keeps a right drawer open below both thresholds', () => {
    expect(shouldCloseOnDragEnd('right', makeDragInfo(10, 100))).toBe(false)
  })
})

/** Controlled wrapper mirroring how `Sidebar` drives the drawer (open is parent-owned). */
const Harness = ({ onOpenChange }: { onOpenChange: (open: boolean) => void }) => {
  const [open, setOpen] = useState(true)
  return (
    <MobileSidebar
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        onOpenChange(next)
      }}
    >
      <div>sidebar content</div>
    </MobileSidebar>
  )
}

const getOverlay = () => document.querySelector('[data-slot="sidebar-overlay"]')!

const flushAnimations = async () => {
  await act(async () => {
    await getClock().runAllAsync()
  })
}

describe('MobileSidebar', () => {
  it('closes via onOpenChange(false) when the overlay is tapped', async () => {
    const onOpenChange = mock()
    render(<Harness onOpenChange={onOpenChange} />)

    fireEvent.click(getOverlay())
    await flushAnimations()

    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('ignores a second overlay tap while the close is already running (isAnimating guard)', async () => {
    const onOpenChange = mock()
    render(<Harness onOpenChange={onOpenChange} />)

    const overlay = getOverlay()
    fireEvent.click(overlay)
    fireEvent.click(overlay)
    await flushAnimations()

    expect(onOpenChange).toHaveBeenCalledTimes(1)
  })
})
