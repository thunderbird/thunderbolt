/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { SessionState, VoiceSession, VoiceSessionOptions } from '@/voice/session'

type SessionCallbacks = Pick<VoiceSessionOptions, 'onState' | 'onError' | 'onLevel'>
type SessionOwner = { session: VoiceSession | null; controller: AbortController }

type LifecycleOptions = {
  onStarting: () => void
  onStopped: () => void
  onState: (state: SessionState) => void
  onError: (error: unknown, terminal: boolean) => void
  onLevel: (level: number) => void
  onActiveChange: (active: boolean) => void
}

/** Owns a voice attempt from lazy loading through teardown; superseded callbacks are inert. */
export const createSessionLifecycle = (options: LifecycleOptions) => {
  let active: SessionOwner | null = null

  const stop = async () => {
    const owner = active
    active = null
    owner?.controller.abort()
    options.onActiveChange(false)
    options.onStopped()
    await owner?.session?.stop()
  }

  const start = async (prepare: (callbacks: SessionCallbacks, signal: AbortSignal) => Promise<VoiceSession | null>) => {
    if (active) {
      return
    }
    const owner: SessionOwner = { session: null, controller: new AbortController() }
    active = owner
    options.onActiveChange(true)
    options.onStarting()
    try {
      const session = await prepare(
        {
          onState: (state) => {
            if (active === owner) {
              options.onState(state)
            }
          },
          onError: (error) => {
            if (active === owner) {
              options.onError(error, false)
            }
          },
          onLevel: (level) => {
            if (active === owner) {
              options.onLevel(level)
            }
          },
        },
        owner.controller.signal,
      )
      if (active !== owner) {
        await session?.stop()
        return
      }
      if (!session) {
        active = null
        options.onActiveChange(false)
        options.onStopped()
        return
      }
      owner.session = session
      await session.start()
    } catch (error) {
      if (active !== owner) {
        return
      }
      active = null
      options.onActiveChange(false)
      options.onError(error, true)
      await owner.session?.stop()
    }
  }

  return { start, stop, getOutputLevel: () => active?.session?.getOutputLevel() ?? 0 }
}
