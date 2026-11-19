/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { BrowserSample } from './probe'

/** Nearest-rank percentile; missing observations stay missing rather than looking instant. */
export const percentile = (values: number[], fraction: number): number | null => {
  if (!Number.isFinite(fraction) || fraction < 0 || fraction > 1 || values.some((value) => !Number.isFinite(value))) {
    throw new Error('Percentiles require finite samples and a fraction between 0 and 1')
  }
  if (!values.length) {
    return null
  }
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)]
}

/** Collapse Event Timing entries for the same interaction before reporting latency. */
export const summarizeSample = (sample: BrowserSample) => {
  const interactions = new Map<number, number>()
  sample.events.forEach((event) => {
    interactions.set(event.interactionId, Math.max(interactions.get(event.interactionId) ?? 0, event.durationMs))
  })
  return {
    windowMs: sample.durationMs,
    firstFrameMs: sample.firstFrameMs,
    frameP95Ms: percentile(sample.framesMs, 0.95),
    frameMaxMs: percentile(sample.framesMs, 1),
    frameGapsOver50Ms: sample.framesMs.filter((gap) => gap > 50).length,
    longTaskCount: sample.supportedEntryTypes.includes('longtask') ? sample.longTasksMs.length : null,
    blockingMs: sample.supportedEntryTypes.includes('longtask')
      ? sample.longTasksMs.reduce((sum, ms) => sum + Math.max(0, ms - 50), 0)
      : null,
    interactionP95Ms: percentile([...interactions.values()], 0.95),
    interactionMaxMs: percentile([...interactions.values()], 1),
    inputDelayMaxMs: percentile(
      sample.events.map((event) => event.inputDelayMs),
      1,
    ),
    processingMaxMs: percentile(
      sample.events.map((event) => event.processingMs),
      1,
    ),
    presentationDelayMaxMs: percentile(
      sample.events.map((event) => event.presentationDelayMs),
      1,
    ),
    reactCommits: sample.reactCommits,
  }
}
