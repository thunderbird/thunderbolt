/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { getClock } from '@/testing-library'
import { describe, expect, it } from 'bun:test'
import { createPendingRequests } from './pending-requests'

describe('createPendingRequests', () => {
  it('resolves a request with the reply it was sent for', async () => {
    const pending = createPendingRequests()
    let sentId = 0

    const answer = pending.issue((id) => {
      sentId = id
    }, 1_000)
    pending.settle(sentId, { items: ['a'] })

    expect(await answer).toEqual({ items: ['a'] })
  })

  it('gives each request its own id, so concurrent replies do not cross', async () => {
    const pending = createPendingRequests()
    const ids: number[] = []

    const first = pending.issue((id) => ids.push(id), 1_000)
    const second = pending.issue((id) => ids.push(id), 1_000)

    expect(new Set(ids).size).toBe(2)
    // Answer out of order — the whole point of correlating by id.
    pending.settle(ids[1], 'second')
    pending.settle(ids[0], 'first')

    expect(await first).toBe('first')
    expect(await second).toBe('second')
  })

  /** The property every caller depends on: a silent guest never hangs a turn. */
  it('resolves null when nothing answers before the timeout', async () => {
    const pending = createPendingRequests()

    const answer = pending.issue(() => {}, 50)
    await getClock().runAllAsync()

    expect(await answer).toBeNull()
  })

  it('reports an unknown id rather than throwing', () => {
    expect(createPendingRequests().settle(999, 'nobody asked')).toBe(false)
  })

  it('ignores a second reply to the same request', async () => {
    const pending = createPendingRequests()
    let sentId = 0

    const answer = pending.issue((id) => {
      sentId = id
    }, 1_000)

    expect(pending.settle(sentId, 'first')).toBe(true)
    expect(pending.settle(sentId, 'duplicate')).toBe(false)
    expect(await answer).toBe('first')
  })

  it('does not fire a timeout for a request that already answered', async () => {
    const pending = createPendingRequests()
    let sentId = 0

    const answer = pending.issue((id) => {
      sentId = id
    }, 50)
    pending.settle(sentId, 'answered')
    await getClock().runAllAsync()

    expect(await answer).toBe('answered')
  })

  it('releases everything outstanding on teardown', async () => {
    const pending = createPendingRequests()

    const first = pending.issue(() => {}, 10_000)
    const second = pending.issue(() => {}, 10_000)
    pending.abortAll()

    expect(await first).toBeNull()
    expect(await second).toBeNull()
  })
})
