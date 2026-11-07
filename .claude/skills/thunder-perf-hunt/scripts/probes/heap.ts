/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { CDPSession, Page } from 'playwright'
import type { HeapDelta } from '../lib/types'

/**
 * Force a garbage collection, then read the used JS heap size (bytes) and the
 * current DOM node count. Falls back to `performance.memory` for the heap when
 * `Runtime.getHeapUsage` is unavailable.
 */
const measure = async (session: CDPSession, page: Page): Promise<{ bytes: number; nodes: number }> => {
  await session.send('HeapProfiler.collectGarbage')

  const usage = await session
    .send('Runtime.getHeapUsage')
    .then((r) => (r as { usedSize: number }).usedSize)
    .catch(() => 0)
  const bytes =
    usage > 0
      ? usage
      : ((await page.evaluate(
          `(() => performance.memory?.usedJSHeapSize ?? 0)()`,
        )) as number)

  const counters = (await session.send('Memory.getDOMCounters')) as { nodes: number }
  return { bytes, nodes: counters.nodes }
}

/**
 * Measure the JS heap and DOM-node delta across an action that stress-tests
 * cleanup (typically navigate away and back). Chromium only — returns null on
 * any CDP error (e.g. Firefox, where CDP sessions are unavailable).
 */
export const collectHeapDelta = async (
  page: Page,
  label: string,
  action: () => Promise<void>,
): Promise<HeapDelta | null> => {
  const session = await page
    .context()
    .newCDPSession(page)
    .catch(() => null)
  if (!session) return null

  try {
    await session.send('HeapProfiler.enable')
    const before = await measure(session, page)

    await action()

    const after = await measure(session, page)

    return {
      label,
      beforeBytes: before.bytes,
      afterBytes: after.bytes,
      deltaBytes: after.bytes - before.bytes,
      domNodesDelta: after.nodes - before.nodes,
    }
  } catch {
    return null
  } finally {
    await session.detach().catch(() => {})
  }
}
