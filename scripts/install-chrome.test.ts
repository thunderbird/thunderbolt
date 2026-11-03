/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Browser, BrowserPlatform, Cache, InstalledBrowser } from '@puppeteer/browsers'
import { getChromeExecutablePath } from './chrome'
import { installChrome } from './install-chrome'

const cacheDir = mkdtempSync(join(tmpdir(), 'thunderbolt-install-chrome-'))
afterAll(() => rmSync(cacheDir, { recursive: true, force: true }))

const platform = BrowserPlatform.LINUX

/** Stands in for install() on a cache hit: it returns the browser without touching aliases. */
const cachedInstall = async ({ buildId }: { buildId: string }) =>
  new InstalledBrowser(new Cache(cacheDir), Browser.CHROME, buildId, platform)

describe('installChrome', () => {
  test('points the stable alias at the resolved build when install() hits the cache', async () => {
    const cache = new Cache(cacheDir)
    cache.writeMetadata(Browser.CHROME, { aliases: { stable: '156.0.8078.80' } })

    const result = await installChrome({
      platform,
      cacheDir,
      install: cachedInstall,
      resolveBuildId: async () => '156.0.8078.81',
    })

    expect(result.buildId).toBe('156.0.8078.81')
    expect(cache.readMetadata(Browser.CHROME).aliases.stable).toBe('156.0.8078.81')
    expect(getChromeExecutablePath(cacheDir)).toContain('156.0.8078.81')
  })

  test('rejects a platform Chrome for Testing does not ship', async () => {
    const resolveBuildId = async () => {
      throw new Error('resolveBuildId should not run')
    }
    await expect(
      installChrome({ platform: undefined, cacheDir, install: cachedInstall, resolveBuildId }),
    ).rejects.toThrow('Chrome for Testing does not support')
  })
})
