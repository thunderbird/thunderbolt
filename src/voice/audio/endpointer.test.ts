/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, test } from 'bun:test'
import { createEndpointer, endSilenceFrames, minSpeechFrames } from './endpointer'

// A frame loud enough to clear speechRmsThreshold, and a silent one.
const loud = () => new Float32Array(512).fill(0.5)
const quiet = () => new Float32Array(512)

type Counts = { speechStarts: number; utterances: number; misfires: number }
const drive = (frames: Float32Array[]): Counts => {
  const counts: Counts = { speechStarts: 0, utterances: 0, misfires: 0 }
  const ep = createEndpointer({
    onSpeechStart: () => counts.speechStarts++,
    onUtterance: () => counts.utterances++,
    onMisfire: () => counts.misfires++,
  })
  for (const f of frames) {
    ep.processFrame(f)
  }
  return counts
}

describe('createEndpointer', () => {
  test('a short blip never fires barge-in and commits nothing (misfire)', () => {
    // Fewer than minSpeechFrames of speech, then trailing silence. This is the
    // regression guard for the "cut the assistant off, then commit nothing" bug:
    // barge-in must NOT fire below the commit threshold.
    const counts = drive([
      ...Array.from({ length: minSpeechFrames - 1 }, loud),
      ...Array.from({ length: endSilenceFrames }, quiet),
    ])
    expect(counts.speechStarts).toBe(0)
    expect(counts.utterances).toBe(0)
    expect(counts.misfires).toBe(1)
  })

  test('sustained speech fires barge-in exactly once, then commits after silence', () => {
    const counts = drive([
      ...Array.from({ length: minSpeechFrames + 5 }, loud),
      ...Array.from({ length: endSilenceFrames }, quiet),
    ])
    expect(counts.speechStarts).toBe(1) // barge-in, once, at the commit threshold
    expect(counts.utterances).toBe(1) // and it always yields a committed turn
    expect(counts.misfires).toBe(0)
  })

  test('barge-in and commit share the same gate, so a barge-in always commits', () => {
    // The moment barge-in fires (minSpeechFrames reached), the utterance is
    // already commit-eligible — there is no window where one fires without the other.
    const counts = drive([
      ...Array.from({ length: minSpeechFrames }, loud),
      ...Array.from({ length: endSilenceFrames }, quiet),
    ])
    expect(counts.speechStarts).toBe(1)
    expect(counts.utterances).toBe(1)
  })
})
