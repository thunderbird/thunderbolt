/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { expect, test, type Page } from './test'
import { defaultModelOpus55 } from '../shared/defaults/models'
import { fakeArtifactPrompt, fakeArtifactTitle, fakeProviderReply } from './fake-provider'
import { collectPageErrors, loginViaEmailCode, sendChatPrompt } from './helpers'

/** Reveal navigation on narrow viewports while leaving the persistent desktop sidebar alone. */
const setMobileNavigationOpen = async (page: Page, open: boolean) => {
  if ((page.viewportSize()?.width ?? 768) >= 768) {
    return
  }
  const drawer = page.locator('[data-slot="sidebar"][data-mobile="true"][data-open]')
  if (open) {
    await page.getByRole('button', { name: 'Toggle Sidebar', exact: true }).click()
    await expect(drawer).toBeVisible()
    return
  }
  await page.keyboard.press('Escape')
  await expect(drawer).toHaveCount(0)
}

/** Exercise real rendering, synced preference persistence and every presentation through the product UI. */
test('a generated artifact can be pinned, opened in every display mode, reloaded and unpinned', async ({
  page,
  viewport,
}) => {
  // The persistent WebKit fixture creates its context before applying device options.
  if (viewport) {
    await page.setViewportSize(viewport)
  }
  const errors = collectPageErrors(page)
  const narrow = (page.viewportSize()?.width ?? 768) < 768
  await loginViaEmailCode(page)
  await page.getByTestId('model-selector-trigger').click()
  await page.getByRole('button', { name: defaultModelOpus55.name, exact: true }).click()
  await sendChatPrompt(page, fakeArtifactPrompt)
  await expect(page.getByText(fakeProviderReply, { exact: true })).toBeVisible({ timeout: 30_000 })
  const sourceChat = new URL(page.url()).pathname
  const frame = page.locator(`iframe[title="${fakeArtifactTitle}"]`)
  const content = page.frameLocator(`iframe[title="${fakeArtifactTitle}"]`)
  await expect(frame).toHaveCount(1)
  await expect(frame).toHaveAttribute('sandbox', 'allow-scripts')
  await content.getByRole('button', { name: 'Increment', exact: true }).click()
  await expect(content.getByLabel('Counter')).toHaveText('1')
  expect(
    await content.locator('body').evaluate(() => {
      try {
        return window.parent.document.body.tagName
      } catch {
        return 'isolated'
      }
    }),
  ).toBe('isolated')

  await page.getByRole('button', { name: 'Pin artifact', exact: true }).click()
  const pinnedItem = page
    .locator('[data-sidebar="content"]')
    .getByRole('button', { name: fakeArtifactTitle, exact: true })
  await setMobileNavigationOpen(page, true)
  await expect(pinnedItem).toBeVisible()
  const artifactSection = page.getByRole('button', { name: 'Artifacts', exact: true })
  await artifactSection.click()
  await expect(artifactSection).toHaveAttribute('aria-expanded', 'false')
  await expect(pinnedItem).toBeHidden()
  await expect(page).toHaveURL(new RegExp(`${sourceChat}$`))
  await artifactSection.click()
  await expect(pinnedItem).toBeVisible()
  await pinnedItem.click({ button: 'right' })
  await expect(page).toHaveURL(new RegExp(`${sourceChat}$`))
  await page.getByRole('menuitem', { name: 'Rename', exact: true }).click()
  const nameInput = page.getByRole('textbox', { name: 'Artifact name', exact: true })
  await expect(nameInput).toBeFocused()
  await nameInput.fill('Renamed sidebar artifact')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  const renamedItem = page
    .locator('[data-sidebar="content"]')
    .getByRole('button', { name: 'Renamed sidebar artifact', exact: true })
  await expect(renamedItem).toBeVisible()
  if (!narrow) {
    await page.getByRole('button', { name: 'Toggle Sidebar', exact: true }).click()
    const railMenu = page.getByRole('button', { name: 'Artifacts', exact: true })
    await expect(railMenu).toHaveAttribute('aria-haspopup', 'menu')
    await railMenu.click()
    await page.getByRole('menuitem', { name: 'Renamed sidebar artifact', exact: true }).click({ button: 'right' })
  } else {
    await renamedItem.click({ button: 'right' })
  }
  await page.getByRole('menuitem', { name: 'Rename', exact: true }).click()
  await expect(nameInput).toBeFocused()
  await nameInput.fill(fakeArtifactTitle)
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  if (!narrow) {
    await page.keyboard.press('Escape')
    await page.getByRole('button', { name: 'Toggle Sidebar', exact: true }).click()
  }
  await expect(pinnedItem).toBeVisible()
  await pinnedItem.click()
  await expect(page).toHaveURL(/\/artifacts\//)
  await expect(page.getByRole('button', { name: 'Chat', exact: true })).toBeVisible()
  await expect(content.getByLabel('Counter')).toHaveText('0')
  await expect(frame).toHaveCount(1)
  await content.getByRole('button', { name: 'Increment', exact: true }).click()
  await expect(content.getByLabel('Counter')).toHaveText('1')

  await page.getByRole('button', { name: 'Open in side panel', exact: true }).click()
  await expect(page.locator('textarea')).toBeVisible()
  await expect(frame).toHaveCount(1)
  await page.locator('textarea').fill('Keep this unsent artifact question.')
  if (narrow) {
    await expect(frame).toBeHidden()
    await page.getByRole('button', { name: 'Close panel', exact: true }).click()
  } else {
    await expect(content.getByLabel('Counter')).toHaveText('1')
    const handle = page.locator('[data-slot="resizable-handle"]:visible')
    const handleBounds = await handle.boundingBox()
    const artifactWidth = await frame.evaluate((element) => element.getBoundingClientRect().width)
    expect(handleBounds).not.toBeNull()
    await page.mouse.move(handleBounds!.x + handleBounds!.width / 2, handleBounds!.y + handleBounds!.height / 2)
    await page.mouse.down()
    await page.mouse.move(handleBounds!.x - 80, handleBounds!.y + handleBounds!.height / 2, { steps: 8 })
    await page.mouse.up()
    await expect
      .poll(() => frame.evaluate((element) => element.getBoundingClientRect().width))
      .toBeGreaterThan(artifactWidth + 40)
  }
  await expect(content.getByLabel('Counter')).toHaveText('1')
  await page.getByRole('button', { name: 'Open full screen', exact: true }).click()
  await expect(frame).toHaveCount(1)
  await expect(content.getByLabel('Counter')).toHaveText('1')
  if (!narrow) {
    await expect(page.locator('textarea')).toHaveValue('Keep this unsent artifact question.')
  }

  await page.getByRole('button', { name: 'Show inline', exact: true }).click()
  await expect(page).toHaveURL(new RegExp(`${sourceChat}\\?view=chat$`))
  await expect(frame).toHaveCount(1)
  await expect(frame).toHaveAttribute('sandbox', 'allow-scripts')
  await page.getByRole('button', { name: 'Open in side panel', exact: true }).click()
  await expect(page.getByText(`${fakeArtifactTitle} — shown in side panel`)).toHaveCount(1)
  await expect(frame).toHaveCount(1)
  await content.getByRole('button', { name: 'Increment', exact: true }).click()
  await expect(content.getByLabel('Counter')).toHaveText('1')
  await page.getByRole('button', { name: 'Open full screen', exact: true }).click()
  await expect(page).toHaveURL(/\/artifacts\//)
  await expect(frame).toHaveCount(1)

  await page.reload()
  await expect(frame).toHaveCount(1)
  await setMobileNavigationOpen(page, true)
  await expect(pinnedItem).toBeVisible()
  await pinnedItem.click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Unpin artifact', exact: true }).click()
  await expect(pinnedItem).toHaveCount(0)
  await setMobileNavigationOpen(page, false)
  await expect(frame).toHaveCount(1)
  await page.reload()
  await expect(frame).toHaveCount(1)
  await expect(page.getByRole('button', { name: 'Pin artifact', exact: true })).toBeEnabled()
  await setMobileNavigationOpen(page, true)
  await expect(pinnedItem).toHaveCount(0)
  await setMobileNavigationOpen(page, false)
  await setMobileNavigationOpen(page, true)
  await expect(page.getByRole('button', { name: 'Browse artifacts', exact: true })).toHaveCount(0)
  await expect(page.getByRole('dialog', { name: 'Artifacts', exact: true })).toHaveCount(0)
  await setMobileNavigationOpen(page, false)
  expect(errors).toEqual([])
})
