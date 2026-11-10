/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { isTinfoilAttestationRequest } from './tinfoil-isolation'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defaultModelDeepSeekV41Flash } from '../shared/defaults/models'
import { collectPageErrors, loginViaEmailCode } from './helpers'
import { importBackup } from './import-backup'
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
    page.waitForEvent('console', (message) => message.text().includes('prewarmTinfoilModel: warm-up skipped')),
    loginViaEmailCode(page),
  ])
  await expect(page.getByTestId('model-selector-trigger')).toContainText(defaultModelDeepSeekV41Flash.name)
  expect(response.url()).toBe('https://atc.tinfoil.sh/routers')
  expect(response.status()).toBe(503)
  expect(await response.json()).toEqual({ error: 'Attestation is disabled in this test project' })
  expect(errors).toEqual([])
}

for (const viewport of [
  { width: 1280, height: 900 },
  { width: 390, height: 844 },
]) {
  test.describe(`direct Tinfoil prewarm at ${viewport.width}px`, () => {
    test.use({ viewport })

    test('verifies automatically on selection and after restoring the selected model', async ({ page }) => {
      const email = await loginViaEmailCode(page)
      const connectionId = crypto.randomUUID()
      const model = {
        ...defaultModelDeepSeekV41Flash,
        id: crypto.randomUUID(),
        name: 'Personal DeepSeek',
        isSystem: 0,
        providerConnectionId: connectionId,
      }
      await importBackup(page, {
        format: 'thunderbolt-export',
        schemaVersion: 1,
        exportedAt: new Date().toISOString(),
        user: { id: 'prewarm-fixture', email },
        tables: {
          models: [model],
          provider_connections: [
            {
              id: connectionId,
              provider: 'tinfoil',
              name: 'Tinfoil',
              authMethod: 'api_key',
              url: null,
              enabled: 1,
            },
          ],
          provider_connection_secrets: [
            {
              id: connectionId,
              binding: JSON.stringify(['tinfoil', 'api_key', null]),
              credentials: JSON.stringify({ apiKey: 'test-prewarm-key' }),
            },
          ],
        },
      })
      await page.goto('/chats/new')
      const selector = page.getByTestId('model-selector-trigger')
      await selector.click()
      await expect(page.getByRole('button', { name: 'Verification failed', exact: true })).toBeVisible()

      const attestation = () => page.waitForResponse((response) => response.url() === 'https://atc.tinfoil.sh/routers')
      await Promise.all([
        attestation(),
        page.getByRole('button', { name: `${model.name} Tinfoil`, exact: true }).click(),
      ])
      await expect(selector).toContainText(model.name)
      await expect(page.getByRole('button', { name: 'Verification failed', exact: true })).toBeVisible()

      await Promise.all([attestation(), page.reload()])
      await expect(selector).toContainText(model.name)
      await selector.click()
      await expect(page.getByRole('button', { name: 'Verification failed', exact: true })).toBeVisible()
    })
  })
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
      await context.route(isTinfoilAttestationRequest, async (route) => {
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
