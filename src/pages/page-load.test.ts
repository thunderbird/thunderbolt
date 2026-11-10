/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it, mock } from 'bun:test'
import { waitForPageLoad } from './page-load'
import { getClock } from '@/testing-library'

describe('page navigation settlement', () => {
  it('waits for delayed loading, redirects, and a stable final URL', async () => {
    const states = [
      { url: 'https://old.example', isLoading: false },
      { url: 'https://old.example', isLoading: true },
      { url: 'https://redirect.example', isLoading: false },
      { url: 'https://final.example', isLoading: false },
      { url: 'https://final.example', isLoading: false },
    ]
    const read = mock(async () => states.shift()!)
    const pending = waitForPageLoad(read, undefined, { quietMs: 1 })
    await getClock().tickAsync(1000)
    await pending
    expect(read).toHaveBeenCalledTimes(5)
  })

  it('allows same-document navigation and no-op history once the engine is quiet', async () => {
    const read = mock(async () => ({ url: 'https://same.example/#section', isLoading: false }))
    const pending = waitForPageLoad(read, undefined, { quietMs: 1 })
    await getClock().tickAsync(1000)
    await pending
    expect(read).toHaveBeenCalledTimes(2)
  })

  it('rejects load failures and times out a page that never settles', async () => {
    await expect(
      waitForPageLoad(async () => ({ url: '', isLoading: false, error: 'Connection refused' })),
    ).rejects.toThrow('Connection refused')
    const pending = waitForPageLoad(async () => ({ url: 'https://example.com', isLoading: true }), undefined, {
      timeoutMs: 20,
    }).catch((error: unknown) => error)
    await getClock().tickAsync(21)
    expect(await pending).toMatchObject({ message: 'Page is still loading. Wait and observe it again.' })
  })

  it('honors Stop immediately even while a native state query is stuck', async () => {
    const controller = new AbortController()
    const reply = Promise.withResolvers<{ url: string; isLoading: boolean }>()
    const pending = waitForPageLoad(() => reply.promise, controller.signal)
    controller.abort(new Error('Stopped'))
    await expect(pending).rejects.toThrow('Stopped')
    reply.resolve({ url: 'https://example.com', isLoading: false })
    const read = mock(async () => ({ url: '', isLoading: false }))
    await expect(waitForPageLoad(read, controller.signal)).rejects.toThrow('Stopped')
    expect(read).not.toHaveBeenCalled()
  })
})
