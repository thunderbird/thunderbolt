/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { collectPageErrors } from './helpers'
import { expect, isolateProviderRequests, test } from './test'

for (const { projectName, attestationStatus, paths } of [
  { projectName: 'consumer', attestationStatus: 503, paths: ['/routers'] },
  { projectName: 'extended-sync-chromium-desktop', attestationStatus: 503, paths: ['/routers'] },
  { projectName: 'extended-real-chromium-desktop', attestationStatus: 200, paths: ['/attestation', '/routers'] },
]) {
  test(`provider policy for a secondary context in ${projectName}`, async ({ browser }) => {
    const context = await browser.newContext()
    try {
      const upstreamPaths: string[] = []
      // Register the fake upstream first: a missing policy reaches this route, never the internet.
      await context.route('https://atc.tinfoil.sh/**', async (route) => {
        upstreamPaths.push(new URL(route.request().url()).pathname)
        await route.fulfill({ json: { upstream: true } })
      })
      await isolateProviderRequests(context, projectName)
      const page = await context.newPage()
      const errors = collectPageErrors(page)
      const responses = await page.evaluate(async () => {
        const attestation = await fetch('https://atc.tinfoil.sh/attestation')
        const routers = await fetch('https://atc.tinfoil.sh/routers')
        return { attestationStatus: attestation.status, routers: await routers.json() }
      })
      expect(responses).toEqual({ attestationStatus, routers: { upstream: true } })
      expect(upstreamPaths).toEqual(paths)
      expect(errors).toEqual([])

      await page.evaluate(() => {
        queueMicrotask(() => {
          throw new Error('Unrelated application failure')
        })
      })
      await expect.poll(() => errors).toEqual(['Unrelated application failure'])
    } finally {
      await context.close()
    }
  })
}
