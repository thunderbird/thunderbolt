/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, test } from 'bun:test'
import { percentile, summarizeSample } from './metrics'

describe('performance summaries', () => {
  test('does not treat absent Event Timing samples as zero latency', () => {
    expect(percentile([], 0.95)).toBeNull()
    expect(percentile([10, 30, 20], 0.5)).toBe(20)
    expect(percentile([10, 30], 0.5)).toBe(10)
    expect(() => percentile([NaN], 0.5)).toThrow('finite')
    expect(() => percentile([10], 1.1)).toThrow('fraction')
  })

  test('unsupported long-task observation is missing rather than zero blocking time', () => {
    const summary = summarizeSample({
      durationMs: 20,
      firstFrameMs: null,
      framesMs: [],
      longTasksMs: [],
      events: [],
      reactCommits: 0,
      supportedEntryTypes: [],
    })
    expect(summary.blockingMs).toBeNull()
    expect(summary.longTaskCount).toBeNull()
    expect(summary.interactionMaxMs).toBeNull()
  })

  test('deduplicates event entries and counts only the blocking part of long tasks', () => {
    const sample = summarizeSample({
      durationMs: 1000,
      firstFrameMs: 80,
      framesMs: [16.7, 16.7, 66.8],
      longTasksMs: [50, 80, 120],
      events: [
        {
          name: 'pointerdown',
          startMs: 10,
          durationMs: 32,
          inputDelayMs: 4,
          processingMs: 8,
          presentationDelayMs: 20,
          interactionId: 1,
        },
        {
          name: 'click',
          startMs: 30,
          durationMs: 80,
          inputDelayMs: 10,
          processingMs: 20,
          presentationDelayMs: 50,
          interactionId: 1,
        },
        {
          name: 'keydown',
          startMs: 100,
          durationMs: 24,
          inputDelayMs: 2,
          processingMs: 6,
          presentationDelayMs: 16,
          interactionId: 2,
        },
      ],
      reactCommits: 5,
      supportedEntryTypes: ['event', 'longtask'],
    })
    expect(sample.blockingMs).toBe(100)
    expect(sample.longTaskCount).toBe(3)
    expect(sample.frameGapsOver50Ms).toBe(1)
    expect(sample.interactionMaxMs).toBe(80)
    expect(sample.inputDelayMaxMs).toBe(10)
    expect(sample.processingMaxMs).toBe(20)
    expect(sample.presentationDelayMaxMs).toBe(50)
    expect(sample.reactCommits).toBe(5)
  })
})
