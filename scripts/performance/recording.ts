/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { open } from 'node:fs/promises'
import type { CDPSession } from 'playwright'
import { collectCleanupErrors, type CleanupStep } from './cleanup'

export const traceCategories =
  'devtools.timeline,v8.execute,blink.user_timing,disabled-by-default-v8.cpu_profiler,disabled-by-default-devtools.timeline,disabled-by-default-devtools.timeline.frame,disabled-by-default-devtools.screenshot'

/** Snapshot Chrome counters; time values are seconds, heap values are bytes. */
export const chromeMetrics = async (cdp: CDPSession): Promise<Record<string, number>> => {
  const { metrics } = await cdp.send('Performance.getMetrics')
  return Object.fromEntries(metrics.map(({ name, value }: { name: string; value: number }) => [name, value]))
}

/** Collect unreachable objects outside timing windows before comparing retained counters. */
export const retainedChromeMetrics = async (cdp: CDPSession) => {
  await cdp.send('HeapProfiler.collectGarbage')
  const metrics = await chromeMetrics(cdp)
  return { heapBytes: metrics.JSHeapUsedSize, nodes: metrics.Nodes, listeners: metrics.JSEventListeners }
}

/** Copy the CDP stream without buffering a whole trace or splitting a multibyte UTF-8 character. */
const writeTraceStream = async (cdp: CDPSession, stream: string, path: string) => {
  const file = await open(path, 'w')
  let failed = false
  try {
    for (;;) {
      const chunk = await cdp.send('IO.read', { handle: stream })
      await file.writeFile(chunk.base64Encoded ? Buffer.from(chunk.data, 'base64') : chunk.data)
      if (chunk.eof) {
        break
      }
    }
  } catch (error) {
    failed = true
    throw error
  } finally {
    await closeTraceResource({ name: 'trace file', run: () => file.close() }, failed)
  }
}

/** A cleanup error must not replace the read/write error that explains a truncated trace. */
const closeTraceResource = async (step: CleanupStep, failed: boolean) => {
  const errors = await collectCleanupErrors([step])
  if (!errors.length) {
    return
  }
  if (failed) {
    console.error(errors[0])
    return
  }
  throw new Error(errors[0])
}

/** Save an optional Chrome Performance trace; tracing runs are diagnostic, never benchmark samples. */
export const finishTrace = async (cdp: CDPSession, path: string, timeoutMs = 30_000) => {
  const complete = Promise.withResolvers<{ stream?: string }>()
  cdp.once('Tracing.tracingComplete', complete.resolve)
  const timer = setTimeout(
    () => complete.reject(new Error('Chrome did not finish the trace within the capture timeout')),
    timeoutMs,
  )
  try {
    const [, { stream }] = await Promise.all([cdp.send('Tracing.end'), complete.promise])
    if (!stream) {
      throw new Error('Chrome did not return the requested trace stream')
    }
    let failed = false
    try {
      await writeTraceStream(cdp, stream, path)
    } catch (error) {
      failed = true
      throw error
    } finally {
      await closeTraceResource({ name: 'trace stream', run: () => cdp.send('IO.close', { handle: stream }) }, failed)
    }
  } finally {
    clearTimeout(timer)
    cdp.off('Tracing.tracingComplete', complete.resolve)
  }
}
