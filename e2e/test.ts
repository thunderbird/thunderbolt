/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test as base } from '@playwright/test'

export { expect, type Page, type Request, type Route } from '@playwright/test'

const persistentWebkit = base.extend({
  context: async ({ playwright }, use, testInfo) => {
    const profile = await mkdtemp(join(tmpdir(), 'thunderbolt-nightly-webkit-'))
    const videoDir = testInfo.outputPath('videos')
    try {
      await mkdir(videoDir, { recursive: true })
      const context = await playwright.webkit.launchPersistentContext(profile, { recordVideo: { dir: videoDir } })
      try {
        await use(context)
      } finally {
        try {
          if (testInfo.status !== testInfo.expectedStatus) {
            for (const page of context.pages()) {
              const video = page.video()
              if (!video) continue
              await page.close()
              await testInfo.attach('video', { path: await video.path(), contentType: 'video/webm' })
            }
          }
        } finally {
          await context.close()
        }
      }
    } finally {
      await Promise.all([
        rm(videoDir, { recursive: true, force: true }),
        rm(profile, { recursive: true, force: true }),
      ])
    }
  },
  page: async ({ context }, use) => {
    await use(context.pages()[0] ?? (await context.newPage()))
  },
})

export const test = process.env.E2E_NIGHTLY_WEBKIT_PERSISTENT === 'true' ? persistentWebkit : base
