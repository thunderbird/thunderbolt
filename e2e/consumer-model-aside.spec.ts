/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { expect, test, type Page } from './test'
import { importBackup } from './import-backup'
import { loginViaEmailCode } from './helpers'

/** Import an isolated connection whose catalog is fulfilled locally, without provider credentials. */
const prepareCatalog = async (page: Page, count: number, savedCount = 0) => {
  const email = await loginViaEmailCode(page)
  const connectionId = crypto.randomUUID()
  const url = 'http://localhost:18991/v1'
  await page.route(`${url}/models`, (route) =>
    route.fulfill({
      json: {
        data: Array.from({ length: count }, (_, index) => ({
          id: `catalog-${String(index + 1).padStart(2, '0')}`,
          name: `Catalog model ${index + 1}`,
        })),
      },
    }),
  )
  await importBackup(page, {
    format: 'thunderbolt-export',
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    user: { id: 'catalog-layout-fixture', email },
    tables: {
      provider_connections: [
        { id: connectionId, provider: 'custom', name: 'Catalog fixture', authMethod: 'api_key', url, enabled: 1 },
      ],
      provider_connection_secrets: [
        {
          id: connectionId,
          binding: JSON.stringify(['custom', 'api_key', url]),
          credentials: JSON.stringify({ apiKey: 'catalog-layout-key' }),
        },
      ],
      models: Array.from({ length: savedCount }, (_, index) => ({
        id: crypto.randomUUID(),
        providerConnectionId: connectionId,
        provider: 'custom',
        name: `Saved model ${index + 1}`,
        model: `saved-${index + 1}`,
        enabled: 1,
        isSystem: 0,
        toolUsage: 1,
      })),
    },
  })
}

for (const viewport of [
  { width: 1280, height: 900 },
  { width: 390, height: 844 },
]) {
  test.describe(`model catalog layout at ${viewport.width}px`, () => {
    test.use({ viewport })

    test('fills the aside while keeping the controls and actions outside the scrolling catalog', async ({ page }) => {
      await page.emulateMedia({ reducedMotion: 'reduce' })
      await prepareCatalog(page, 60)

      for (const entry of ['chat', 'settings']) {
        await page.goto(entry === 'chat' ? '/chats/new' : '/settings/models')
        if (entry === 'chat') {
          await page.getByTestId('model-selector-trigger').click()
          await page.getByRole('button', { name: 'Add Model', exact: true }).click()
        } else {
          await page.getByRole('button', { name: 'New Model', exact: true }).click()
        }
        const connection = page.getByRole('combobox', { name: 'Connection', exact: true })
        await connection.click()
        await page.getByRole('option', { name: 'Catalog fixture', exact: true }).click()
        const catalog = page.getByRole('group', { name: 'Models', exact: true })
        await expect(catalog.getByRole('checkbox')).toHaveCount(60)
        const search = page.getByRole('textbox', { name: 'Search models', exact: true })
        const add = page.getByRole('button', { name: 'Add models', exact: true })
        const cancel = page.getByRole('button', { name: 'Cancel', exact: true })
        await expect(add).toBeInViewport()
        await expect(cancel).toBeInViewport()

        const catalogBox = await catalog.boundingBox()
        const addBox = await add.boundingBox()
        expect(catalogBox).not.toBeNull()
        expect(addBox).not.toBeNull()
        // The catalog consumes the available middle of the panel, ending just
        // above its footer rather than imposing a fixed-height inner viewport.
        const footerGap = addBox!.y - (catalogBox!.y + catalogBox!.height)
        expect(footerGap).toBeGreaterThanOrEqual(0)
        expect(footerGap).toBeLessThan(100)
        const panelBottom = await catalog.evaluate(
          (element) => element.closest('section')!.getBoundingClientRect().bottom,
        )
        expect(panelBottom - (addBox!.y + addBox!.height)).toBeLessThan(40)

        const controls = [connection, search, cancel, add]
        const positions = await Promise.all(controls.map((control) => control.boundingBox()))
        await catalog.evaluate((element) => {
          element.scrollTop = element.scrollHeight
        })
        await expect.poll(() => catalog.evaluate((element) => element.scrollTop)).toBeGreaterThan(0)
        await expect(catalog.getByRole('checkbox', { name: 'Catalog model 60', exact: true })).toBeInViewport()
        for (const [index, control] of controls.entries()) {
          const position = await control.boundingBox()
          expect(position).not.toBeNull()
          expect(Math.abs(position!.y - positions[index]!.y)).toBeLessThan(1)
        }
        if (viewport.width < 768) {
          await page.evaluate(() => document.documentElement.style.setProperty('--kb', '280px'))
          await expect
            .poll(() => catalog.evaluate((element) => element.closest('section')!.getBoundingClientRect().bottom))
            .toBeLessThanOrEqual(viewport.height - 279)
          await expect.poll(() => catalog.evaluate((element) => element.clientHeight)).toBeGreaterThan(60)
          const keyboardPanelBottom = await catalog.evaluate(
            (element) => element.closest('section')!.getBoundingClientRect().bottom,
          )
          const keyboardAddBox = await add.boundingBox()
          expect(keyboardAddBox!.y + keyboardAddBox!.height).toBeLessThanOrEqual(keyboardPanelBottom)
          await expect(search).toBeInViewport()
          await page.evaluate(() => document.documentElement.style.removeProperty('--kb'))

          await page.getByRole('button', { name: 'Enter a model ID', exact: true }).click()
          await page.evaluate(() => document.documentElement.style.setProperty('--kb', '360px'))
          const manualId = page.getByRole('textbox', { name: 'Model ID', exact: true })
          await expect
            .poll(() => manualId.evaluate((element) => element.closest('section')!.getBoundingClientRect().bottom))
            .toBeLessThanOrEqual(viewport.height - 359)
          await manualId.fill('local/model')
          await manualId.scrollIntoViewIfNeeded()
          await expect(add).toBeEnabled()
          const manualBox = await manualId.boundingBox()
          const manualAddBox = await add.boundingBox()
          expect(manualBox!.y + manualBox!.height).toBeLessThanOrEqual(manualAddBox!.y)
          await page.evaluate(() => document.documentElement.style.removeProperty('--kb'))
        }
      }
    })

    test('keeps catalog selections through search and keyboard input, and discards them on cancel', async ({
      page,
    }) => {
      await prepareCatalog(page, 500, 50)
      await page.goto('/settings/models')
      await expect(page.getByRole('button', { name: 'Open Saved model 1', exact: true })).toBeVisible()
      const openCatalog = async () => {
        await page.getByRole('button', { name: 'New Model', exact: true }).click()
        await page.getByRole('combobox', { name: 'Connection', exact: true }).click()
        await page.getByRole('option', { name: 'Catalog fixture', exact: true }).click()
      }
      await openCatalog()
      const catalog = page.getByRole('group', { name: 'Models', exact: true })
      await expect(catalog.getByRole('checkbox')).toHaveCount(500)
      const first = catalog.getByRole('checkbox', { name: 'Catalog model 1', exact: true })
      await first.focus()
      await page.keyboard.press('Space')
      await expect(first).toBeChecked()

      const search = page.getByRole('textbox', { name: 'Search models', exact: true })
      await search.fill('Catalog model 500')
      const last = catalog.getByRole('checkbox', { name: 'Catalog model 500', exact: true })
      await expect(catalog.getByRole('checkbox')).toHaveCount(1)
      await last.focus()
      await page.keyboard.press('Space')
      await expect(last).toBeChecked()
      await search.fill('')
      await expect(catalog.getByRole('checkbox')).toHaveCount(500)
      await expect(first).toBeChecked()
      await expect(last).toBeChecked()
      await expect(page.getByRole('button', { name: 'Add models', exact: true })).toBeEnabled()

      await page.getByRole('button', { name: 'Cancel', exact: true }).click()
      await expect(catalog).toBeHidden()
      await openCatalog()
      await expect(catalog.getByRole('checkbox')).toHaveCount(500)
      await expect(first).not.toBeChecked()
      await expect(last).not.toBeChecked()
      await expect(page.getByRole('button', { name: 'Add models', exact: true })).toBeDisabled()
      await first.check()
      await page.getByRole('button', { name: 'Add models', exact: true }).click()
      await expect(catalog).toBeHidden()
      await expect(page.getByRole('button', { name: 'Open Catalog model 1', exact: true })).toBeVisible()
      await expect(page.getByRole('button', { name: 'Open Saved model 1', exact: true })).toBeVisible()
    })
  })
}
