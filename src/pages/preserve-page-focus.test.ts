/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import '@/testing-library'
import { afterEach, describe, expect, it } from 'bun:test'
import { preservePageFocus } from './preserve-page-focus'

afterEach(() => document.body.replaceChildren())

const setup = () => {
  const prompt = document.createElement('textarea')
  prompt.value = 'keep my selection'
  const host = document.createElement('div')
  host.dataset.pageHost = 'session'
  const frame = document.createElement('iframe')
  host.append(frame)
  document.body.append(prompt, host)
  prompt.focus()
  prompt.setSelectionRange(5, 7)
  return { prompt, frame }
}

describe('synthetic page focus', () => {
  it('restores the prompt and its selection after input focuses the frame', async () => {
    const { prompt, frame } = setup()
    await preservePageFocus('session', async () => frame.focus())
    expect(document.activeElement).toBe(prompt)
    expect([prompt.selectionStart, prompt.selectionEnd]).toEqual([5, 7])
  })
  it('does not steal focus when the user selects another control during an action', async () => {
    const { frame } = setup()
    const other = document.createElement('input')
    document.body.append(other)
    const reply = Promise.withResolvers<void>()
    const pending = preservePageFocus('session', async () => {
      frame.focus()
      await reply.promise
    })
    other.focus()
    reply.resolve()
    await pending
    expect(document.activeElement).toBe(other)
  })
  it('restores focus on failure and leaves detached controls alone', async () => {
    const { prompt, frame } = setup()
    await expect(
      preservePageFocus('session', async () => {
        frame.focus()
        throw new Error('Failed')
      }),
    ).rejects.toThrow('Failed')
    expect(document.activeElement).toBe(prompt)
    await preservePageFocus('session', async () => {
      frame.focus()
      prompt.remove()
    })
    expect(document.activeElement).toBe(frame)
  })
})
