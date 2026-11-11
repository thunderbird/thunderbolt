/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { expect, test } from '@playwright/test'

test('recovery loads without starting the app and retries only on request', async ({ page }) => {
  const workers: string[] = []
  page.on('worker', (worker) => workers.push(worker.url()))
  const requests: string[] = []
  page.on('request', (request) => requests.push(request.url()))
  await page.addInitScript(() => {
    localStorage.setItem('recovery-data-sentinel', 'keep')
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
  await expect(page.getByRole('heading', { name: "Thunderbolt couldn't keep running" })).toBeVisible()
  await expect(page.getByText('Automatic reloads have been paused.', { exact: false })).toBeVisible()
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
