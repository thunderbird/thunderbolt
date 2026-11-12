/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { expect, test } from './test'
import { loginViaEmailCode } from './helpers'

test('browser activity uses a subtle brand gradient in both themes and keeps Stop and Resume usable', async ({
  page,
}) => {
  await loginViaEmailCode(page)
  await page.getByRole('button', { name: 'Open browser', exact: true }).click()
  await page.evaluate(async () => {
    const controllerPath = '/src/browser/browser-controller.ts'
    const storePath = '/src/pages/page-store.ts'
    const { browserController } = (await import(controllerPath)) as typeof import('../src/browser/browser-controller')
    const { usePageStore } = (await import(storePath)) as typeof import('../src/pages/page-store')
    browserController.startAgentTurn('banner-style')
    browserController.forAgentTurn('banner-style').claimPage(usePageStore.getState().activeId!)
  })
  const banner = page.locator('[data-page-panel]').getByRole('status')
  await expect(banner).toHaveText(/Agent is using this tab/)
  for (const dark of [false, true]) {
    await page.evaluate((dark) => document.documentElement.classList.toggle('dark', dark), dark)
    await expect(banner).toHaveCSS('background-image', /linear-gradient/)
    await expect(banner).toHaveCSS(
      'color',
      await page.locator('[data-page-panel]').evaluate((panel) => getComputedStyle(panel).color),
    )
    await expect(banner.getByRole('button', { name: 'Stop control' })).toBeVisible()
  }
  await banner.getByRole('button', { name: 'Stop control' }).click()
  await expect(banner).toHaveText(/Browser control paused/)
  await expect(banner).toHaveCSS('background-image', /linear-gradient/)
  await banner.getByRole('button', { name: 'Resume' }).click()
  await expect(banner).toHaveCount(0)
  await page.evaluate(async () => {
    const modulePath = '/src/browser/browser-controller.ts'
    const { browserController } = (await import(modulePath)) as typeof import('../src/browser/browser-controller')
    browserController.startAgentTurn('banner-style')()
  })
})

test('the header browser toggle restores the last selected tab without creating a blank tab', async ({ page }) => {
  await loginViaEmailCode(page)
  await page.getByRole('button', { name: 'Open browser', exact: true }).click()
  await page.evaluate(async () => {
    const modulePath = '/src/pages/page-controller.ts'
    const { pageController } = (await import(modulePath)) as typeof import('../src/pages/page-controller')
    for (const session of pageController.list()) {
      pageController.close(session.sessionId)
    }
    const recent = pageController.open({
      id: 'toggle-recent',
      title: 'Most recently selected',
      source: { kind: 'html', html: '<label>Draft <input aria-label="Draft"></label>' },
    })
    pageController.open({
      id: 'toggle-newer',
      title: 'Created later',
      source: { kind: 'html', html: '<h1>Other page</h1>' },
    })
    pageController.select(recent)
  })
  const panel = page.locator('[data-page-panel]')
  const tab = panel.getByRole('tab', { name: 'Most recently selected', exact: true })
  const frame = page.locator('[data-page-host] iframe[title="Most recently selected"]')
  await expect(tab).toHaveAttribute('aria-selected', 'true')
  await expect(panel.getByRole('tab')).toHaveCount(2)
  await frame.contentFrame().getByRole('textbox', { name: 'Draft' }).fill('Keep this draft')
  await frame.evaluate((element) => element.setAttribute('data-retained-frame', 'toggle-retained'))
  await page.locator('[data-browser-toggle]').click()
  await expect(panel).toHaveCount(0)
  await page.getByRole('button', { name: 'Open browser', exact: true }).click()
  await expect(panel.getByRole('tab')).toHaveCount(2)
  await expect(tab).toHaveAttribute('aria-selected', 'true')
  await expect(frame).toHaveAttribute('data-retained-frame', 'toggle-retained')
  await expect(frame.contentFrame().getByRole('textbox', { name: 'Draft' })).toHaveValue('Keep this draft')
})
