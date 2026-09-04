/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterEach, describe, expect, mock, test } from 'bun:test'
import { render } from '@testing-library/react'
import { setPendingPrompt, useConsumePendingPrompt, usePendingPromptStore } from './pending-prompt-store'

const { getState, setState } = usePendingPromptStore

afterEach(() => setState({ promptsByThread: {} }))

/** Lets the `queueMicrotask` handover in `useConsumePendingPrompt` run. */
const flushMicrotasks = () => new Promise<void>((resolve) => queueMicrotask(resolve))

const Consumer = ({ threadId, onConsume }: { threadId: string; onConsume: (prompt: string) => void }) => {
  useConsumePendingPrompt(threadId, onConsume)
  return null
}

describe('pending-prompt-store', () => {
  test('setPendingPrompt stores per thread without touching other threads', () => {
    setPendingPrompt('t1', 'explain this')
    setPendingPrompt('t2', 'and this')
    expect(getState().promptsByThread).toEqual({ t1: 'explain this', t2: 'and this' })
  })

  test('a later prompt for the same thread replaces the earlier one', () => {
    setPendingPrompt('t1', 'first')
    setPendingPrompt('t1', 'second')
    expect(getState().promptsByThread.t1).toBe('second')
  })

  test('clearPrompt removes the thread entry entirely', () => {
    setPendingPrompt('t1', 'gone')
    getState().clearPrompt('t1')
    expect(getState().promptsByThread.t1).toBeUndefined()
  })
})

describe('useConsumePendingPrompt', () => {
  test('delivers a prompt queued before the consumer mounts', async () => {
    setPendingPrompt('t1', 'explain this chart')
    const onConsume = mock()

    render(<Consumer threadId="t1" onConsume={onConsume} />)
    await flushMicrotasks()

    expect(onConsume).toHaveBeenCalledWith('explain this chart')
  })

  test('delivers a prompt queued while the consumer is already mounted', async () => {
    const onConsume = mock()
    render(<Consumer threadId="t1" onConsume={onConsume} />)
    await flushMicrotasks()
    expect(onConsume).not.toHaveBeenCalled()

    setPendingPrompt('t1', 'now what?')
    await flushMicrotasks()

    expect(onConsume).toHaveBeenCalledWith('now what?')
  })

  test('clears the prompt once delivered, so a remount does not resurrect it', async () => {
    setPendingPrompt('t1', 'one shot')
    const onConsume = mock()

    const { unmount } = render(<Consumer threadId="t1" onConsume={onConsume} />)
    await flushMicrotasks()
    expect(getState().promptsByThread.t1).toBeUndefined()

    unmount()
    render(<Consumer threadId="t1" onConsume={onConsume} />)
    await flushMicrotasks()

    expect(onConsume).toHaveBeenCalledTimes(1)
  })

  test('ignores prompts addressed to another thread', async () => {
    setPendingPrompt('t2', 'not for you')
    const onConsume = mock()

    render(<Consumer threadId="t1" onConsume={onConsume} />)
    await flushMicrotasks()

    expect(onConsume).not.toHaveBeenCalled()
    expect(getState().promptsByThread.t2).toBe('not for you')
  })

  test('delivers the same text twice when it is proposed again', async () => {
    const onConsume = mock()
    render(<Consumer threadId="t1" onConsume={onConsume} />)

    setPendingPrompt('t1', 'again')
    await flushMicrotasks()
    setPendingPrompt('t1', 'again')
    await flushMicrotasks()

    expect(onConsume).toHaveBeenCalledTimes(2)
  })
})
