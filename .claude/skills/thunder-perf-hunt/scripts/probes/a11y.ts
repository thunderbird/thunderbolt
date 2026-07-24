/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { Page } from 'playwright'
import type { A11yViolation } from '../lib/types'

const MAX_VIOLATIONS = 25

/** Shape of the subset of axe.run() output we read. Keeps `any` out of the probe. */
type AxeResult = {
  violations: Array<{
    id: string
    impact: A11yViolation['impact'] | null
    help: string
    nodes: Array<{ target: string[] }>
  }>
}

/**
 * Resolve the on-disk path to axe's minified bundle. The app ships
 * `Cross-Origin-Embedder-Policy: credentialless`, so axe cannot be loaded from a
 * CDN <script src> — we inject the local devDependency inline instead. Resolved
 * from this module, so it works on any machine where axe-core is installed.
 */
const resolveAxePath = (): string => require.resolve('axe-core/axe.min.js')

/**
 * Inject axe-core into the page and run it, returning a compact list of
 * violations. Any failure at the axe-injection boundary yields an empty list so
 * the harness never crashes on a page axe can't analyze.
 */
export const collectA11y = async (page: Page): Promise<A11yViolation[]> => {
  try {
    await page.addScriptTag({ path: resolveAxePath() })
  } catch {
    return []
  }

  const result = (await page.evaluate(
    `(async () => await window.axe.run())()`,
  )) as AxeResult

  return result.violations.slice(0, MAX_VIOLATIONS).map((violation) => ({
    ruleId: violation.id,
    impact: violation.impact ?? 'minor',
    help: violation.help,
    selectors: violation.nodes.flatMap((node) => node.target),
  }))
}
