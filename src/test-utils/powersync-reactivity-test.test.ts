/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { expect, it, mock } from 'bun:test'
import { waitForElement } from './powersync-reactivity-test'

it('polls for a delayed element without draining unrelated query-cache timers', async () => {
  const element = document.createElement('div')
  const cacheCleanup = mock(() => {})
  const state = { ready: false }
  setTimeout(() => {
    state.ready = true
  }, 100)
  setTimeout(cacheCleanup, 300_000)
  const start = Date.now()

  expect(await waitForElement(() => (state.ready ? element : null))).toBe(element)
  expect(Date.now() - start).toBeLessThan(2_000)
  expect(cacheCleanup).not.toHaveBeenCalled()
})
