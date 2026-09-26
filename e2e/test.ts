/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test as base } from '@playwright/test'
import { parseDbDiagnostic } from './db-diagnostic'

export { expect, type Page, type Request, type Route } from '@playwright/test'

const persistentWebkit = base.extend({
  context: async ({ playwright }, use, testInfo) => {
    const profile = await mkdtemp(join(tmpdir(), 'thunderbolt-extended-webkit-'))
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
      await Promise.all([rm(videoDir, { recursive: true, force: true }), rm(profile, { recursive: true, force: true })])
    }
  },
  page: async ({ context, baseURL }, use, testInfo) => {
    const page = context.pages()[0] ?? (await context.newPage())
    const diagnostics: string[] = []
    const dbDiagnostics = { readiness: 'missing', query: 'missing' }
    if (process.env.VITE_DB_DIAGNOSTIC === 'true') {
      page.on('console', (message) => {
        const diagnostic = parseDbDiagnostic(message.text())
        if (diagnostic) dbDiagnostics[diagnostic.phase] = diagnostic.label
      })
    }
    if (baseURL) {
      // WebKit shares OPFS across persistent profiles, so clear the test origin before app boot.
      const origins = testInfo.project.name.startsWith('min-version-gate-')
        ? [baseURL, 'http://localhost:1423']
        : [baseURL]
      const testOrigins = new Set(origins.map((origin) => new URL(origin).origin))
      for (const origin of origins) {
        const url = new URL('/__e2e_storage_reset__', origin).href
        await page.route(url, (route) => route.fulfill({ status: 200, body: '<!doctype html>' }))
        await page.goto(url)
        await page.evaluate(async () => {
          const root = await navigator.storage.getDirectory()
          for await (const name of root.keys()) await root.removeEntry(name, { recursive: true })
        })
        await page.unroute(url)
      }
      page.on('worker', (worker) => {
        const path = new URL(worker.url()).pathname
        if (!path.startsWith('/@powersync/worker/') || diagnostics.length >= 20) return
        diagnostics.push(`worker started ${path}`)
        worker.on('close', () => diagnostics.push(`worker closed ${path}`))
      })
      page.on('requestfailed', (request) => {
        const url = new URL(request.url())
        if (request.resourceType() !== 'script' || !testOrigins.has(url.origin) || diagnostics.length >= 20) return
        diagnostics.push(`script failed ${url.pathname}`)
      })
      page.on('response', (response) => {
        const url = new URL(response.url())
        if (!testOrigins.has(url.origin) || diagnostics.length >= 20) return
        if (
          !url.pathname.startsWith('/@powersync/worker/') &&
          (response.request().resourceType() !== 'script' || response.status() < 400)
        )
          return
        diagnostics.push(`${response.status()} ${response.headers()['content-type'] ?? 'unknown'} ${url.pathname}`)
      })
    }
    try {
      await use(page)
    } finally {
      if (process.env.VITE_DB_DIAGNOSTIC === 'true') {
        await writeFile(
          testInfo.outputPath('db-diagnostic.json'),
          JSON.stringify({
            status: testInfo.status,
            retry: testInfo.retry,
            ...dbDiagnostics,
          }),
        )
      }
      if (testInfo.status !== testInfo.expectedStatus && diagnostics.length) {
        console.error('[e2e] resource diagnostics:', diagnostics.join(' | '))
      }
    }
  },
})

persistentWebkit.afterEach(async ({}, testInfo) => {
  if (process.env.VITE_DB_DIAGNOSTIC !== 'true') return
  await writeFile(
    testInfo.outputPath('db-diagnostic.json'),
    JSON.stringify({ status: testInfo.status, retry: testInfo.retry, readiness: 'missing', query: 'missing' }),
  )
})

export const test = process.env.E2E_EXTENDED_WEBKIT_PERSISTENT === 'true' ? persistentWebkit : base
