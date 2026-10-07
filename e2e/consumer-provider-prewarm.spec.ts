/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defaultModelDeepSeekV41Flash } from '../shared/defaults/models'
import { collectPageErrors, loginViaEmailCode } from './helpers'
import { expect, isolateProviderRequests, resetOriginStorage, test, type Page } from './test'

/** Boot the real app and wait until its default-model prewarm has handled attestation failure. */
const expectIsolatedPrewarm = async (page: Page) => {
  const errors = collectPageErrors(page)
  // Dev haptics stalled this WebKit fixture; provider prewarm needs no device feedback.
  await page.addInitScript(() => {
    localStorage.setItem('thunderbolt-local-settings', JSON.stringify({ state: { hapticsEnabled: false }, version: 0 }))
  })
  const [response] = await Promise.all([
    page.waitForResponse((response) => new URL(response.url()).hostname === 'atc.tinfoil.sh'),
    page.waitForEvent('console', (message) => message.text().includes('runSystemModelPrewarm: warm-up skipped')),
    loginViaEmailCode(page),
  ])
  await expect(page.getByTestId('model-selector-trigger')).toContainText(defaultModelDeepSeekV41Flash.name)
  expect(response.url()).toBe('https://atc.tinfoil.sh/attestation')
  expect(response.status()).toBe(503)
  expect(await response.json()).toEqual({ error: 'Attestation is disabled in this test project' })
  expect(errors).toEqual([])
}

for (const extraPage of [false, true]) {
  test(`app startup isolates prewarm on the ${extraPage ? 'extra' : 'fixture'} page`, async ({ context, page }) => {
    await expectIsolatedPrewarm(extraPage ? await context.newPage() : page)
  })
}

test('app startup isolates default-model prewarm on a second device', async ({
  browser,
  browserName,
  playwright,
  baseURL,
}, testInfo) => {
  if (!baseURL) {
    throw new Error('Consumer prewarm project needs a baseURL')
  }
  // WebKit needs a persistent profile for the app's OPFS database, as in the main fixture.
  const profile = await mkdtemp(join(tmpdir(), 'thunderbolt-prewarm-'))
  try {
    const context =
      browserName === 'webkit'
        ? await playwright.webkit.launchPersistentContext(profile, { baseURL })
        : await browser.newContext({ baseURL })
    try {
      const upstreamRequests: string[] = []
      await context.route('https://atc.tinfoil.sh/**', async (route) => {
        upstreamRequests.push(route.request().url())
        await route.fulfill({ status: 502, json: { error: 'Unexpected external attestation' } })
      })
      await isolateProviderRequests(context, testInfo.project.name)
      const page = await context.newPage()
      if (browserName === 'webkit') {
        await resetOriginStorage(page, baseURL)
      }
      await expectIsolatedPrewarm(page)
      expect(upstreamRequests).toEqual([])
    } finally {
      await context.close()
    }
  } finally {
    await rm(profile, { recursive: true, force: true })
  }
})
