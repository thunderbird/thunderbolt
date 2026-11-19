/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it, spyOn } from 'bun:test'
import { supportsKeyStoreLock, withKeyStoreLock } from './key-store-lock'

// The helper owns no JavaScript queue: independent callers coordinate through
// the origin-wide LockManager, which the browser shares across tabs/workers.
describe('origin-wide key-store lock', () => {
  it('uses the same exclusive browser lock for independent callers and releases after failure', async () => {
    const request = spyOn(navigator.locks, 'request')
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const events: string[] = []
    const firstTab = () =>
      withKeyStoreLock(async () => {
        events.push('first')
        entered.resolve()
        await release.promise
        throw new Error('first failed')
      })
    const secondTab = () =>
      withKeyStoreLock(async () => {
        events.push('second')
        return 42
      })
    try {
      const first = firstTab().then(
        () => null,
        (error: unknown) => error,
      )
      await entered.promise
      const second = secondTab()
      await Promise.resolve()
      expect(events).toEqual(['first'])
      expect(request.mock.calls.map(([name]) => name)).toEqual([
        'thunderbolt-account-key-store',
        'thunderbolt-account-key-store',
      ])
      release.resolve()
      expect(await first).toMatchObject({ message: 'first failed' })
      expect(await second).toBe(42)
      expect(events).toEqual(['first', 'second'])
    } finally {
      request.mockRestore()
    }
  })

  it('reports unsupported managers instead of using a per-tab fallback', () => {
    const previous = navigator.locks
    try {
      Object.defineProperty(navigator, 'locks', { configurable: true, value: {} })
      expect(supportsKeyStoreLock()).toBe(false)
    } finally {
      Object.defineProperty(navigator, 'locks', { configurable: true, value: previous })
    }
    expect(supportsKeyStoreLock()).toBe(true)
  })
})
