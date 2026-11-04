/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { AiSdkChunk } from './pi-to-aisdk-stream.ts'

/** Presentation pacing for provider bursts; the harness continues independently. */
export type PiStreamSmoothing = {
  readonly chunking: (text: string) => string | null
  readonly delayInMs: number
}

export type ArrivingChunk = { readonly chunk: AiSdkChunk; readonly receivedAt: number }

// Never build a typing-animation backlog behind a fast provider or a stalled tab.
const maximumPacingLagMs = 160

/** Wait between visible fragments, releasing immediately when the user presses Stop. */
const waitForPacing = async (delayInMs: number, signal?: AbortSignal): Promise<void> => {
  if (delayInMs <= 0 || signal?.aborted) {
    return
  }
  await new Promise<void>((resolve) => {
    const finish = (): void => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', finish)
      resolve()
    }
    const timer = setTimeout(finish, delayInMs)
    signal?.addEventListener('abort', finish, { once: true })
  })
}

/** Split only text already received; an unfinished word must never await another network chunk. */
const splitReceivedText = (text: string, chunking: PiStreamSmoothing['chunking']): string[] => {
  const fragments: string[] = []
  for (let remaining = text; remaining.length > 0; ) {
    const fragment = chunking(remaining) ?? remaining
    if (fragment.length === 0 || !remaining.startsWith(fragment)) {
      throw new Error('Stream chunking must return a nonempty prefix')
    }
    fragments.push(fragment)
    remaining = remaining.slice(fragment.length)
  }
  return fragments
}

/** Pace received text/reasoning while preserving controls, cancellation, and a bounded display lag. */
export const paceStreamChunks = (
  options: PiStreamSmoothing,
  signal?: AbortSignal,
  timing: { now: () => number; wait: (delayInMs: number, signal?: AbortSignal) => Promise<void> } = {
    now: Date.now,
    wait: waitForPacing,
  },
): TransformStream<ArrivingChunk, AiSdkChunk> => {
  let nextEmissionAt = 0
  return new TransformStream({
    async transform({ chunk, receivedAt }, controller) {
      if (chunk.type !== 'text-delta' && chunk.type !== 'reasoning-delta') {
        controller.enqueue(chunk)
        return
      }
      const deadline = receivedAt + maximumPacingLagMs
      if (signal?.aborted || options.delayInMs <= 0 || timing.now() >= deadline || chunk.delta.length === 0) {
        controller.enqueue(chunk)
        return
      }

      const fragments = splitReceivedText(chunk.delta, options.chunking)
      const availableSlots = Math.max(1, Math.floor((deadline - timing.now()) / options.delayInMs) + 1)
      const groupSize = Math.ceil(fragments.length / availableSlots)
      for (let offset = 0; offset < fragments.length; offset += groupSize) {
        const now = timing.now()
        if (nextEmissionAt > now) {
          await timing.wait(Math.min(nextEmissionAt - now, deadline - now), signal)
        }
        if (signal?.aborted || timing.now() >= deadline) {
          controller.enqueue({ ...chunk, delta: fragments.slice(offset).join('') })
          return
        }
        controller.enqueue({ ...chunk, delta: fragments.slice(offset, offset + groupSize).join('') })
        nextEmissionAt = timing.now() + options.delayInMs
      }
    },
  })
}
