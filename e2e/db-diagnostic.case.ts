/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { writeFile } from 'node:fs/promises'
import { expect, test } from './test'

test('consumer WebKit reaches email after its first database query', async ({ page }, testInfo) => {
  const diagnostics = { readiness: 'missing', query: 'missing' }
  page.on('console', (message) => {
    const match =
      /^\[THU884-DB\] (readiness|query)=(ready|rejected|timed_out) category=(locked|quota|schema|open|worker|wasm|sqlite|other) name=(AbortError|InvalidStateError|NoModificationAllowedError|NotAllowedError|QuotaExceededError|SQLiteError|TypeError|other)$/.exec(
        message.text(),
      )
    if (!match) return
    if (match[1] === 'readiness') diagnostics.readiness = match[0]
    else diagnostics.query = match[0]
  })

  try {
    await page.goto('/')
    const email = page.getByPlaceholder('Email', { exact: true })
    const failed = page
      .getByText('Database failed its first query')
      .or(page.getByText('Database did not become ready within 30s'))
    await expect(email.or(failed)).toBeVisible({ timeout: 40_000 })
    expect(await email.isVisible()).toBe(true)
  } finally {
    await writeFile(testInfo.outputPath('db-diagnostic.json'), JSON.stringify(diagnostics))
    console.info('[THU884-DB]', JSON.stringify(diagnostics))
  }
})
