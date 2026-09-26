/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { collectPageErrors } from './helpers'
import { expect, test } from './test'

test('isolates background attestation without blocking unrelated provider requests', async ({ context, page }) => {
  const errors = collectPageErrors(page)
  const upstreamPaths: string[] = []
  await context.route('https://atc.tinfoil.sh/**', async (route) => {
    upstreamPaths.push(new URL(route.request().url()).pathname)
    await route.fulfill({ json: { upstream: true } })
  })

  const responses = await page.evaluate(async () => {
    const attestation = await fetch('https://atc.tinfoil.sh/attestation')
    const routers = await fetch('https://atc.tinfoil.sh/routers')
    return { attestationStatus: attestation.status, routers: await routers.json() }
  })

  expect(responses).toEqual({ attestationStatus: 503, routers: { upstream: true } })
  expect(upstreamPaths).toEqual(['/routers'])
  expect(errors).toEqual([])

  await page.evaluate(() => {
    queueMicrotask(() => {
      throw new Error('Unrelated application failure')
    })
  })
  await expect.poll(() => errors).toEqual(['Unrelated application failure'])
})
