/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { expect, test } from '@playwright/test'

test.use({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)' })

test('HTML bootstrap protects captured own-property methods before app modules run', async ({ page }) => {
  await page.route('**/webview-recovery.html', async (route) => {
    const response = await route.fetch()
    const html = await response.text()
    await route.fulfill({
      response,
      body: html.replace(
        '</head>',
        `<script type="module">
        globalThis.moduleCapturedOwn = Object.prototype.hasOwnProperty;
      </script></head>`,
      ),
    })
  })
  await page.goto('/webview-recovery.html')
  await expect(page.getByRole('heading', { name: "Thunderbolt couldn't keep running" })).toBeVisible()
  expect(
    await page.evaluate(() => {
      const own = (globalThis as typeof globalThis & { moduleCapturedOwn: typeof Object.prototype.hasOwnProperty })
        .moduleCapturedOwn
      const objects = Array.from({ length: 16 }, (_, index) => ({ present: index, [`shape${index}`]: true }))
      const keys = ['present', 'missing']
      const installed =
        Object.getOwnPropertyDescriptor(own, Symbol.for('thunderbolt.webkitOwnPropertyCompat'))?.value === true
      let total = 0
      for (let index = 0; index < 100_000; index++) {
        total += own.call(objects[(index >>> 1) & 15], keys[index & 1]) ? 1 : 0
      }
      return { installed, total }
    }),
  ).toEqual({ installed: true, total: 50_000 })
})

test('the shipped SQLite worker installs compatibility in its own realm', async ({ page }) => {
  await page.route('**/@powersync/worker.js', async (route) => {
    const response = await route.fetch()
    await route.fulfill({
      response,
      body:
        (await response.text()) +
        `
        self.postMessage({
          installed: Object.getOwnPropertyDescriptor(Object.prototype.hasOwnProperty,
            Symbol.for('thunderbolt.webkitOwnPropertyCompat'))?.value === true,
          ownUndefined: Object.hasOwn({ key: undefined }, 'key'),
          inherited: Object.prototype.hasOwnProperty.call(Object.create({ inherited: true }), 'inherited'),
        });`,
    })
  })
  await page.goto('/webview-recovery.html')
  expect(
    await page.evaluate(
      () =>
        new Promise((resolve, reject) => {
          const worker = new Worker('/@powersync/worker.js', { type: 'module' })
          worker.onmessage = (event: MessageEvent<unknown>) => {
            worker.terminate()
            resolve(event.data)
          }
          worker.onerror = (event) => {
            worker.terminate()
            reject(new Error(event.message))
          }
        }),
    ),
  ).toEqual({ installed: true, ownUndefined: true, inherited: false })
})
