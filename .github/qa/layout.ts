/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { resolve } from 'node:path'
import type { Page } from '@playwright/test'

/** One problem the layout probe confirmed; `target` is `<role> "<accessible name>"`. */
export type LayoutProblem = {
  kind: 'overflow-page' | 'overflow-text' | 'offscreen' | 'covered' | 'behind-keyboard' | 'focus-covered'
  target: string
}

declare global {
  // Declaration merging needs an interface.
  interface Window {
    // Undefined until the probe loads; reading it before then throws, which is what a repro spec should do.
    __qaLayout: { problems: () => LayoutProblem[] }
  }
}

const probePath = resolve(import.meta.dirname, 'layout-probe.js')

/**
 * The layout problems on the page as it stands. Injects the probe when the page lacks it (a repro spec), then waits
 * long enough for the probe to confirm a problem with two checks 500 ms apart.
 */
export const layoutProblems = async (page: Page): Promise<LayoutProblem[]> => {
  if (!(await page.evaluate(() => Boolean(window.__qaLayout)))) await page.addScriptTag({ path: probePath })
  await page.waitForTimeout(1000)
  return page.evaluate(() => window.__qaLayout.problems())
}
