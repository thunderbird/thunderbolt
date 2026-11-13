/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { resolve } from 'node:path'
import type { Page } from '@playwright/test'
import type axe from 'axe-core'

/** `target` is `<role> "<accessible name>"`, or for an `unnamed-control` `<role> "<which control>"`. */
export type LayoutProblem = {
  kind:
    | 'overflow-page'
    | 'overflow-text'
    | 'offscreen'
    | 'covered'
    | 'behind-keyboard'
    | 'focus-covered'
    | 'focused-clipped'
    | 'unnamed-control'
  target: string
}

declare global {
  // Declaration merging needs an interface.
  interface Window {
    // Undefined until the probe loads; reading it before then throws, which is what a repro spec should do. `review`
    // holds the controls axe-core could not settle a name for: a person checks them, they are never findings.
    __qaLayout: { problems: () => LayoutProblem[]; review: () => LayoutProblem[] }
    // axe-core, loaded before the probe.
    axe: typeof axe
  }
}

const probePath = resolve(import.meta.dirname, 'layout-probe.js')
/** axe-core, which the probe needs loaded before it. */
export const axePath = resolve(import.meta.dirname, '../../node_modules/axe-core/axe.min.js')

/** Injects the probe when the page lacks it (a repro spec), then waits for two checks 500 ms apart to confirm. */
export const layoutProblems = async (page: Page): Promise<LayoutProblem[]> => {
  if (!(await page.evaluate(() => Boolean(window.__qaLayout)))) {
    await page.addScriptTag({ path: axePath })
    await page.addScriptTag({ path: probePath })
  }
  await page.waitForTimeout(1000)
  return page.evaluate(() => window.__qaLayout.problems())
}
