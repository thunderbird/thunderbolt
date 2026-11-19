/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { animateSpy, registerFramerMotionMock } from '@/test-utils/framer-motion-mock'
import { getClock } from '@/testing-library'
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'

registerFramerMotionMock()
const { contentViewPanelId, useContentViewPanel } = await import('./use-content-view-panel')

type Animation = {
  from: number
  to: number
  update: (width: number) => void
  complete: () => void
  stop: ReturnType<typeof mock>
}

const animations: Animation[] = []
const originalAnimate = animateSpy.getMockImplementation()!

beforeEach(() => {
  animations.length = 0
  animateSpy.mockImplementation((from, to, options) => {
    const { onUpdate, onComplete } = options as {
      onUpdate: (width: number) => void
      onComplete: () => void
    }
    const stop = mock(() => {})
    animations.push({ from: from as unknown as number, to: to as number, update: onUpdate, complete: onComplete, stop })
    return Object.assign(Promise.resolve(), { stop })
  })
})

afterEach(() => {
  cleanup()
  animateSpy.mockImplementation(originalAnimate)
})

/** Drive imperative resize callbacks as the panel library does during an animation. */
const setup = (savedWidth: number | null = 50) => {
  const width = { current: 0 }
  const saveWidth = mock(async (_width: number) => {})
  const panelRef = {
    current: {
      getSize: () => ({ asPercentage: width.current, inPixels: width.current * 10 }),
      resize: (next: number | string) => {
        width.current = Number.parseFloat(String(next))
        hook.result.current.handleLayoutChanged({ [contentViewPanelId]: width.current })
      },
    },
  }
  const hook = renderHook(
    ({ isOpen, savedWidth }) => useContentViewPanel({ isOpen, savedWidth, panelRef, saveWidth }),
    { initialProps: { isOpen: false, savedWidth } },
  )
  const setOpen = (isOpen: boolean, nextSavedWidth = savedWidth) => {
    hook.rerender({ isOpen, savedWidth: nextSavedWidth })
    act(() => getClock().tick(16))
  }
  const finish = (animation = animations.at(-1)!) => {
    act(() => {
      animation.update(animation.to)
      animation.complete()
    })
  }
  const settleResize = (next: number) => act(() => panelRef.current.resize(next))
  return { ...hook, width, saveWidth, setOpen, finish, settleResize }
}

describe('useContentViewPanel', () => {
  it('restores width without persisting any of the animation frames or closing frames', () => {
    const panel = setup(42)
    panel.setOpen(true)
    expect(animations[0].to).toBe(42)
    for (const width of [3, 6, 10, 18, 26, 34, 39, 42]) {
      act(() => animations[0].update(width))
    }
    panel.finish()
    panel.settleResize(42)
    panel.setOpen(false)
    for (const width of [38, 30, 20, 10, 0]) {
      act(() => animations[1].update(width))
    }
    panel.finish()
    expect(panel.saveWidth).not.toHaveBeenCalled()
    expect(panel.width.current).toBe(0)
  })

  it('persists settled pointer and keyboard resizes and restores the saved size', () => {
    const panel = setup()
    panel.setOpen(true)
    panel.finish()
    panel.settleResize(62)
    panel.settleResize(62)
    panel.settleResize(67)
    expect(panel.saveWidth.mock.calls.map(([width]) => width)).toEqual([62, 67])
    panel.setOpen(false, 67)
    panel.finish()
    panel.setOpen(true, 67)
    expect(animations.at(-1)?.to).toBe(67)
    panel.finish()
    expect(panel.saveWidth).toHaveBeenCalledTimes(2)
  })

  it('keeps in-progress transitions running when the settings query rerenders', () => {
    const panel = setup(42)
    panel.setOpen(true)
    panel.rerender({ isOpen: true, savedWidth: 42 })
    expect(animations).toHaveLength(1)
    expect(animations[0].stop).not.toHaveBeenCalled()
    panel.finish()
  })

  it('retains an explicit resize smaller than one percentage point', () => {
    const panel = setup()
    panel.setOpen(true)
    panel.finish()
    panel.settleResize(50.5)
    expect(panel.saveWidth).toHaveBeenCalledWith(50.5)
    panel.setOpen(false, 50.5)
    panel.finish()
    panel.setOpen(true, 50.5)
    expect(animations.at(-1)?.to).toBe(50.5)
    panel.finish()
    expect(panel.saveWidth).toHaveBeenCalledTimes(1)
  })

  it('restores the latest user width when reopening before its setting refreshes', async () => {
    const panel = setup(42)
    const write = Promise.withResolvers<void>()
    panel.saveWidth.mockImplementationOnce(() => write.promise)
    panel.setOpen(true)
    panel.finish()
    panel.settleResize(62)
    panel.setOpen(false)
    panel.finish()
    panel.setOpen(true)
    expect(animations.at(-1)?.to).toBe(62)
    await act(async () => write.resolve())
  })

  it('uses later settings updates after the resize save settles', async () => {
    const panel = setup(42)
    panel.setOpen(true)
    panel.finish()
    panel.settleResize(62)
    await act(async () => {})
    panel.setOpen(false, 72)
    panel.finish()
    panel.setOpen(true, 72)
    expect(animations.at(-1)?.to).toBe(72)
  })

  it('does not clear a newer pending resize when an older save settles', async () => {
    const panel = setup(42)
    const first = Promise.withResolvers<void>()
    const second = Promise.withResolvers<void>()
    panel.saveWidth.mockImplementationOnce(() => first.promise).mockImplementationOnce(() => second.promise)
    panel.setOpen(true)
    panel.finish()
    panel.settleResize(62)
    panel.settleResize(67)
    await act(async () => first.resolve())
    panel.setOpen(false, 62)
    panel.finish()
    panel.setOpen(true, 62)
    expect(animations.at(-1)?.to).toBe(67)
    await act(async () => second.resolve())
  })

  it('releases a failed pending resize so later settings updates can be restored', async () => {
    const panel = setup(42)
    const write = Promise.withResolvers<void>()
    panel.saveWidth.mockImplementationOnce(() => write.promise)
    panel.setOpen(true)
    panel.finish()
    const saving = panel.result.current.handleLayoutChanged({ [contentViewPanelId]: 62 })
    await act(async () => {
      write.reject(new Error('storage unavailable'))
      await expect(saving).rejects.toThrow('storage unavailable')
    })
    panel.setOpen(false, 72)
    panel.finish()
    panel.setOpen(true, 72)
    expect(animations.at(-1)?.to).toBe(72)
  })

  it('distinguishes separate pending writes of the same width', async () => {
    const panel = setup(42)
    const first = Promise.withResolvers<void>()
    const second = Promise.withResolvers<void>()
    const third = Promise.withResolvers<void>()
    panel.saveWidth
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise)
      .mockImplementationOnce(() => third.promise)
    panel.setOpen(true)
    panel.finish()
    panel.settleResize(62)
    panel.settleResize(67)
    panel.settleResize(62)
    await act(async () => {
      first.resolve()
      second.resolve()
    })
    panel.setOpen(false)
    panel.finish()
    panel.setOpen(true)
    expect(animations.at(-1)?.to).toBe(62)
    await act(async () => third.resolve())
  })

  it('cancels superseded animations and resumes from the current visible width', () => {
    const panel = setup(42)
    panel.setOpen(true)
    act(() => animations[0].update(20))
    panel.setOpen(false)
    expect(animations[0].stop).toHaveBeenCalledTimes(1)
    expect(animations[1].from).toBe(20)
    act(() => animations[1].update(12))
    panel.setOpen(true)
    expect(animations[1].stop).toHaveBeenCalledTimes(1)
    expect(animations[2].from).toBe(12)
    expect(animations[2].to).toBe(42)
    panel.finish()
    expect(panel.saveWidth).not.toHaveBeenCalled()
  })

  it('cancels a queued animation on unmount and ignores layouts while closed', () => {
    const panel = setup()
    panel.settleResize(35)
    expect(panel.saveWidth).not.toHaveBeenCalled()
    panel.rerender({ isOpen: true, savedWidth: 50 })
    panel.unmount()
    act(() => getClock().tick(16))
    expect(animations).toHaveLength(0)
  })

  it.each([null, 0, 5])('uses the default opening width for an unset or collapsed saved width: %s', (savedWidth) => {
    const panel = setup(savedWidth)
    panel.setOpen(true)
    expect(animations[0].to).toBe(50)
    panel.finish()
    expect(panel.saveWidth).not.toHaveBeenCalled()
  })
})
