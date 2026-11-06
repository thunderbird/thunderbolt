/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { minSpeechFrames } from './endpointer'
import { capturedPeak, capturedTones, earconDurationMs, listeningPeak, listeningTones } from './earcon'

/** 512-sample frames at 16 kHz, set by the capture worklet. */
const frameMs = (512 / 16_000) * 1000

describe('earcon tones', () => {
  it('rises to invite the user to speak', () => {
    const [first, second] = listeningTones
    expect(second.hz).toBeGreaterThan(first.hz)
  })

  it('falls to acknowledge, mirroring the invitation', () => {
    const [first, second] = capturedTones
    expect(second.hz).toBeLessThan(first.hz)
  })

  /** Same interval both ways, so there is one shape to learn rather than two. */
  it('uses the same interval in both directions', () => {
    const rising = listeningTones[1].hz / listeningTones[0].hz
    const falling = capturedTones[0].hz / capturedTones[1].hz
    expect(rising).toBeCloseTo(falling, 5)
  })

  it('acknowledges more quietly than it invites', () => {
    expect(capturedPeak).toBeLessThan(listeningPeak)
  })

  it('keeps both tones quiet enough not to startle', () => {
    expect(listeningPeak).toBeLessThan(0.25)
  })

  /**
   * The invariant that keeps an earcon from talking to itself. Both play while
   * the mic is live, so anything lasting as long as the endpointer's sustained-
   * speech window could register as the user barging in — the assistant would
   * cut itself off, or the session would commit its own chime as a turn.
   */
  it('is shorter than the speech the endpointer needs to fire barge-in', () => {
    const bargeInMs = minSpeechFrames * frameMs

    expect(earconDurationMs(listeningTones)).toBeLessThan(bargeInMs)
    expect(earconDurationMs(capturedTones)).toBeLessThan(bargeInMs)
  })

  it('measures duration across the overlap, not per note', () => {
    expect(earconDurationMs([{ hz: 440, startMs: 0, durationMs: 50 }])).toBe(50)
    expect(
      earconDurationMs([
        { hz: 440, startMs: 0, durationMs: 90 },
        { hz: 880, startMs: 60, durationMs: 110 },
      ]),
    ).toBe(170)
  })
})
