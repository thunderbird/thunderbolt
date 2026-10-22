/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterEach, beforeEach, expect, it, mock, spyOn } from 'bun:test'
import { getClock } from '@/testing-library'
import { afterPaint, preloadInBackground } from './after-paint'

const originalHidden = Object.getOwnPropertyDescriptor(document, 'hidden')

/** Sets visibility without relying on the DOM emulator's default state. */
const setHidden = (hidden: boolean) => Object.defineProperty(document, 'hidden', { configurable: true, value: hidden })

beforeEach(() => setHidden(false))
afterEach(() => {
  if (originalHidden) {
    Object.defineProperty(document, 'hidden', originalHidden)
  } else {
    Reflect.deleteProperty(document, 'hidden')
  }
})

it('allows a rendering opportunity before running visible-tab work once', async () => {
  const work = mock()
  afterPaint(work)
  await getClock().tickAsync(16)
  expect(work).not.toHaveBeenCalled()
  await getClock().tickAsync(16)
  expect(work).toHaveBeenCalledTimes(1)
  setHidden(true)
  document.dispatchEvent(new Event('visibilitychange'))
  await getClock().runAllAsync()
  expect(work).toHaveBeenCalledTimes(1)
})

it('runs hidden-tab work without waiting for a suspended animation frame', async () => {
  setHidden(true)
  const frame = spyOn(globalThis, 'requestAnimationFrame').mockImplementation(() => 1)
  const work = mock()
  try {
    afterPaint(work)
    expect(work).not.toHaveBeenCalled()
    await getClock().tickAsync(0)
    expect(work).toHaveBeenCalledTimes(1)
    expect(frame).not.toHaveBeenCalled()
  } finally {
    frame.mockRestore()
  }
})

it.each([0, 16])('switches to a timer when hidden after %i ms, without duplicating work', async (elapsed) => {
  const work = mock()
  afterPaint(work)
  await getClock().tickAsync(elapsed)
  setHidden(true)
  document.dispatchEvent(new Event('visibilitychange'))
  document.dispatchEvent(new Event('visibilitychange'))
  setHidden(false)
  document.dispatchEvent(new Event('visibilitychange'))
  await getClock().tickAsync(1)
  expect(work).toHaveBeenCalledTimes(1)
  await getClock().runAllAsync()
  expect(work).toHaveBeenCalledTimes(1)
})

it.each([false, true])(
  'cancels pending work and releases visibility handling when initially hidden=%s',
  async (hidden) => {
    setHidden(hidden)
    const work = mock()
    const cancel = afterPaint(work)
    cancel()
    setHidden(true)
    document.dispatchEvent(new Event('visibilitychange'))
    await getClock().runAllAsync()
    expect(work).not.toHaveBeenCalled()
  },
)

it('cancels the second frame before a visibility change can schedule a timer', async () => {
  const work = mock()
  const cancel = afterPaint(work)
  await getClock().tickAsync(16)
  cancel()
  setHidden(true)
  document.dispatchEvent(new Event('visibilitychange'))
  await getClock().runAllAsync()
  expect(work).not.toHaveBeenCalled()
})

it('cancels the fallback timer after a visible tab becomes hidden', async () => {
  const work = mock()
  const cancel = afterPaint(work)
  setHidden(true)
  document.dispatchEvent(new Event('visibilitychange'))
  cancel()
  await getClock().runAllAsync()
  expect(work).not.toHaveBeenCalled()
})

it('defers optional work and cancels it before it starts', async () => {
  const work = mock()
  const cancel = afterPaint(work)
  expect(work).not.toHaveBeenCalled()
  cancel()
  await getClock().runAllAsync()
  expect(work).not.toHaveBeenCalled()
})

it('warms routes serially and stops scheduling after cancellation', async () => {
  const first = Promise.withResolvers<void>()
  const firstLoader = mock(() => first.promise)
  const secondLoader = mock(async () => {})
  const cancel = preloadInBackground([firstLoader, secondLoader])
  await getClock().runAllAsync()
  expect(firstLoader).toHaveBeenCalledTimes(1)
  expect(secondLoader).not.toHaveBeenCalled()
  cancel()
  first.resolve()
  await getClock().runAllAsync()
  expect(secondLoader).not.toHaveBeenCalled()
})

it('continues warming after one route fails', async () => {
  const secondLoader = mock(async () => {})
  preloadInBackground([
    async () => {
      throw new Error('chunk unavailable')
    },
    secondLoader,
  ])
  await getClock().runAllAsync()
  expect(secondLoader).toHaveBeenCalledTimes(1)
})
