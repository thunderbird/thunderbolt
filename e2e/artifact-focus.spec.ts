/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { expect, test } from './test'

// Bundle the production observer; a copy of its listener logic would miss wiring regressions.
const observer = execFileSync(
  'bun',
  [
    'build',
    fileURLToPath(new URL('./fixtures/artifact-focus.ts', import.meta.url)),
    '--target=browser',
    '--format=iife',
  ],
  { encoding: 'utf8' },
)

test('artifact context follows iframe focus across documents and releases its observer', async ({ page }) => {
  await page.setContent(`
    <button id="host">Host control</button>
    <button id="unsubscribe">Stop observing</button>
    <output id="focused">none</output>
    <iframe id="first" sandbox="allow-scripts" srcdoc="<button>First artifact</button>"></iframe>
    <iframe id="second" sandbox="allow-scripts" srcdoc="<button>Second artifact</button>"></iframe>
  `)
  await page.addScriptTag({ content: observer })
  const focused = page.locator('#focused')
  await page.frameLocator('#first').getByRole('button').click()
  await expect(focused).toHaveText('first')
  await page.frameLocator('#second').getByRole('button').click()
  await expect(focused).toHaveText('second')
  await page.frameLocator('#first').getByRole('button').click()
  await expect(focused).toHaveText('first')
  await page.locator('#host').click()
  await expect(focused).toHaveText('none')
  await page.locator('#unsubscribe').click()
  await page.frameLocator('#second').getByRole('button').click()
  await expect(focused).toHaveText('none')
})
