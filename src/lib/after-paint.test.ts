/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { expect, it, mock } from 'bun:test'
import { getClock } from '@/testing-library'
import { afterPaint, preloadInBackground } from './after-paint'

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
