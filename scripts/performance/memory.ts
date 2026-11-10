/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { expect } from '@playwright/test'
import type { CDPSession, Page } from 'playwright'

/** Collect comparable renderer counters after Chrome has reclaimed unreachable objects. */
const snapshotMemory = async (cdp: CDPSession) => {
  await cdp.send('HeapProfiler.collectGarbage')
  const [heap, dom] = await Promise.all([cdp.send('Runtime.getHeapUsage'), cdp.send('Memory.getDOMCounters')])
  return {
    jsHeapUsedBytes: heap.usedSize as number,
    jsHeapTotalBytes: heap.totalSize as number,
    documents: dom.documents as number,
    nodes: dom.nodes as number,
    listeners: dom.jsEventListeners as number,
  }
}

/** Repeat a harmless overlay lifecycle after warmup, outside the interaction timing windows. */
export const measureOverlayRetention = async (page: Page, cdp: CDPSession) => {
  const accountButton = page.getByRole('button', { name: 'Delete My Account', exact: true })
  const confirmation = page.getByRole('alertdialog', { name: 'Delete your account?', exact: true })
  const cycle = async () => {
    await accountButton.click()
    await expect(confirmation).toBeVisible()
    await confirmation.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(confirmation).toBeHidden()
    await page.waitForTimeout(250)
  }

  await cycle()
  const before = await snapshotMemory(cdp)
  const cycles = 10
  for (let index = 0; index < cycles; index++) {
    await cycle()
  }
  const after = await snapshotMemory(cdp)
  return {
    name: 'settings-confirmation-open-cancel',
    cycles,
    before,
    after,
    delta: {
      jsHeapUsedBytes: after.jsHeapUsedBytes - before.jsHeapUsedBytes,
      jsHeapTotalBytes: after.jsHeapTotalBytes - before.jsHeapTotalBytes,
      documents: after.documents - before.documents,
      nodes: after.nodes - before.nodes,
      listeners: after.listeners - before.listeners,
    },
    notes: [
      'One warmup cycle precedes the baseline; both snapshots follow forced garbage collection.',
      'Renderer-wide counters include background work and caches. A positive delta alone does not prove a leak.',
      'Heap capacity can remain allocated after collection; compare used bytes and DOM/listener trends across runs.',
    ],
  }
}
