/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { expect, test } from '@playwright/test'

test('recovery loads without starting the app and retries only on request', async ({ page }) => {
  await page.setViewportSize({ width: 500, height: 640 })
  const workers: string[] = []
  page.on('worker', (worker) => workers.push(worker.url()))
  const requests: string[] = []
  page.on('request', (request) => requests.push(request.url()))
  await page.addInitScript(() => {
    localStorage.setItem('recovery-data-sentinel', 'keep')
    Object.defineProperty(window, 'isTauri', { value: true })
    Object.defineProperty(window, '__TAURI_OS_PLUGIN_INTERNALS__', { value: { platform: 'macos' } })
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      value: {
        invoke: async (command: string) => {
          if (command !== 'retry_webview_after_crash') {
            throw new Error(`Unexpected command: ${command}`)
          }
          sessionStorage.setItem('recovery-retried', 'true')
        },
      },
    })
  })

  await page.goto('/webview-recovery.html')
  await expect(page.getByRole('heading', { name: 'Thunderbolt ran into a problem' })).toBeVisible()
  await expect(page.getByText('Automatic reloads have been paused.', { exact: false })).toBeVisible()
  await expect(page.locator('main img')).toBeVisible()
  expect(await page.locator('main img').evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0)
  await expect(page.locator('html')).toHaveClass(/force-desktop/)
  await expect(page.getByRole('button', { name: 'Try again' })).toHaveCSS('font-size', '14px')
  expect(await page.evaluate(() => sessionStorage.getItem('recovery-retried'))).toBeNull()
  expect(workers).toEqual([])
  expect(requests.filter((url) => /powersync|wa-sqlite|\/src\/(?:index\.tsx|app\.tsx)/.test(url))).toEqual([])

  await page.getByRole('button', { name: 'Try again' }).click()
  await expect(page.getByRole('button', { name: 'Try again' })).toBeDisabled()
  expect(await page.evaluate(() => sessionStorage.getItem('recovery-retried'))).toBe('true')
  expect(await page.evaluate(() => localStorage.getItem('recovery-data-sentinel'))).toBe('keep')
})

test('a failed native retry stays readable and enables another attempt', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      value: {
        invoke: async () => {
          throw new Error('Native navigation unavailable')
        },
      },
    })
  })
  await page.goto('/webview-recovery.html')
  await page.getByRole('button', { name: 'Try again' }).click()
  await expect(page.getByRole('alert')).toHaveText('Could not restart the app. Quit Thunderbolt and open it again.')
  await expect(page.getByRole('button', { name: 'Try again' })).toBeEnabled()
  await expect(page).toHaveURL(/\/webview-recovery\.html$/)
})

test('recovery respects the persisted language without opening the database', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('thunderbolt_locale', 'de'))
  await page.goto('/webview-recovery.html')
  await expect(page.locator('html')).toHaveAttribute('lang', 'de')
  await expect(page.getByRole('button', { name: 'Erneut versuchen' })).toBeEnabled()
})

for (const theme of ['light', 'dark'] as const) {
  for (const width of [500, 390]) {
    test(`recovery uses the ${theme} app theme and remains usable at ${width}px`, async ({ page, browserName }) => {
      await page.setViewportSize({ width, height: 390 })
      await page.emulateMedia({ colorScheme: theme === 'light' ? 'dark' : 'light' })
      await page.addInitScript((theme) => {
        localStorage.setItem('thunderbolt-local-settings', JSON.stringify({ version: 1, state: { theme } }))
      }, theme)
      await page.goto('/webview-recovery.html')

      await expect(page.locator('html')).toHaveCSS('color-scheme', theme)
      await expect(page.locator('body')).toHaveCSS(
        'background-color',
        theme === 'light' ? 'rgb(245, 242, 238)' : 'rgb(27, 30, 31)',
      )
      await expect(page.locator('h1')).toHaveCSS('font-family', /Mozilla Headline/)
      const retry = page.getByRole('button', { name: 'Try again' })
      await expect(retry).toHaveCSS('background-image', /linear-gradient/)
      // A short viewport must scroll to its controls instead of clipping them like the app shell.
      await retry.scrollIntoViewIfNeeded()
      await expect(retry).toBeInViewport()
      // macOS WebKit uses Option-Tab to include buttons in keyboard navigation.
      await page.keyboard.press(browserName === 'webkit' && process.platform === 'darwin' ? 'Alt+Tab' : 'Tab')
      await expect(retry).toBeFocused()
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)

      await page.emulateMedia({ colorScheme: theme })
      await page.emulateMedia({ colorScheme: theme === 'light' ? 'dark' : 'light' })
      await expect(page.locator('html')).toHaveCSS('color-scheme', theme)
    })
  }
}

test('recovery follows system appearance even when saved settings are unreadable', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('thunderbolt-local-settings', '{broken'))
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.goto('/webview-recovery.html')
  await expect(page.locator('html')).toHaveCSS('color-scheme', 'dark')
  await expect(page.getByRole('button', { name: 'Try again' })).toBeEnabled()
  await page.emulateMedia({ colorScheme: 'light' })
  await expect(page.locator('html')).toHaveCSS('color-scheme', 'light')
})
