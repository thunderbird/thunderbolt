/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it, mock } from 'bun:test'
import type { VoiceSession, VoiceSessionOptions } from '@/voice/session'
import { createSessionLifecycle } from './session-lifecycle'

const makeSession = (): VoiceSession => ({
  start: mock(async () => {}),
  stop: mock(async () => {}),
  state: 'idle',
  getOutputLevel: () => 0,
})
const makeLifecycle = () => {
  const events: unknown[] = []
  const lifecycle = createSessionLifecycle({
    onStarting: () => events.push('starting'),
    onStopped: () => events.push('stopped'),
    onState: (state) => events.push(state),
    onError: (error) => events.push(error),
    onLevel: (level) => events.push(level),
    onActiveChange: (active) => events.push(active),
  })
  return { lifecycle, events }
}

describe('voice session ownership', () => {
  it('forwards current callbacks and output level only while the session is owned', async () => {
    const { lifecycle, events } = makeLifecycle()
    const callbacks: Array<Pick<VoiceSessionOptions, 'onState' | 'onError' | 'onLevel'>> = []
    const session = { ...makeSession(), getOutputLevel: () => 0.75 }
    expect(lifecycle.getOutputLevel()).toBe(0)
    await lifecycle.start(async (value) => {
      callbacks.push(value)
      return session
    })
    const error = new Error('recoverable turn error')
    callbacks[0].onState?.('thinking')
    callbacks[0].onError?.(error)
    callbacks[0].onLevel?.(0.5)
    expect(events).toEqual([true, 'starting', 'thinking', error, 0.5])
    expect(lifecycle.getOutputLevel()).toBe(0.75)
    await lifecycle.stop()
    expect(lifecycle.getOutputLevel()).toBe(0)
    expect(session.stop).toHaveBeenCalledTimes(1)
  })

  for (const phase of ['prepare', 'start'] as const) {
    it(`reports a ${phase} failure, cleans up, and permits a fresh attempt`, async () => {
      const { lifecycle, events } = makeLifecycle()
      const failure = new Error(`${phase} failed`)
      const session = {
        ...makeSession(),
        start: mock(async () => {
          throw failure
        }),
      }
      await lifecycle.start(async () => {
        if (phase === 'prepare') {
          throw failure
        }
        return session
      })
      expect(events).toEqual([true, 'starting', false, failure])
      expect(session.stop).toHaveBeenCalledTimes(phase === 'start' ? 1 : 0)
      const replacement = makeSession()
      await lifecycle.start(async () => replacement)
      expect(replacement.start).toHaveBeenCalledTimes(1)
      await lifecycle.stop()
      expect(replacement.stop).toHaveBeenCalledTimes(1)
    })
  }

  it('closes a session prepared after stop without starting its microphone', async () => {
    const { lifecycle } = makeLifecycle()
    const pending = Promise.withResolvers<VoiceSession>()
    const start = lifecycle.start(() => pending.promise)
    await lifecycle.stop()
    const session = makeSession()
    pending.resolve(session)
    await start
    expect(session.start).not.toHaveBeenCalled()
    expect(session.stop).toHaveBeenCalledTimes(1)
  })

  it('admits only one start even before lazy loading has finished', async () => {
    const { lifecycle } = makeLifecycle()
    const pending = Promise.withResolvers<VoiceSession>()
    const prepare = mock(() => pending.promise)
    const first = lifecycle.start(prepare)
    await lifecycle.start(prepare)
    expect(prepare).toHaveBeenCalledTimes(1)
    pending.resolve(makeSession())
    await first
    await lifecycle.stop()
  })

  it('does not let an old startup failure stop or report errors in its replacement', async () => {
    const { lifecycle, events } = makeLifecycle()
    const pending = Promise.withResolvers<void>()
    const old = { ...makeSession(), start: () => pending.promise }
    const first = lifecycle.start(async () => old)
    await Promise.resolve()
    await lifecycle.stop()
    const current = makeSession()
    await lifecycle.start(async () => current)
    const before = [...events]
    pending.reject(new Error('old start failed'))
    await first
    expect(events).toEqual(before)
    expect(current.stop).not.toHaveBeenCalled()
    await lifecycle.stop()
  })

  it('ignores late callbacks and does not clear a new session after slow teardown', async () => {
    const { lifecycle, events } = makeLifecycle()
    const teardown = Promise.withResolvers<void>()
    const callbacks: Array<Pick<VoiceSessionOptions, 'onState' | 'onError' | 'onLevel'>> = []
    await lifecycle.start(async (value) => {
      callbacks.push(value)
      return { ...makeSession(), stop: () => teardown.promise }
    })
    const stopping = lifecycle.stop()
    const current = makeSession()
    await lifecycle.start(async () => current)
    const before = [...events]
    callbacks[0].onState?.('idle')
    callbacks[0].onError?.(new Error('late'))
    callbacks[0].onLevel?.(1)
    teardown.resolve()
    await stopping
    expect(events).toEqual(before)
    expect(current.stop).not.toHaveBeenCalled()
    await lifecycle.stop()
  })
})
