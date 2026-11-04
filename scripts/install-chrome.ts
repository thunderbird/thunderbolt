/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { appendFileSync } from 'node:fs'
import {
  Browser,
  type BrowserPlatform,
  BrowserTag,
  detectBrowserPlatform,
  install,
  type InstalledBrowser,
  type InstallOptions,
  resolveBuildId,
} from '@puppeteer/browsers'
import { $ } from 'bun'
import { getChromeCacheDir } from './chrome'

type InstallChromeDeps = {
  platform: BrowserPlatform | undefined
  cacheDir: string
  install: (options: InstallOptions & { unpack?: true }) => Promise<InstalledBrowser>
  resolveBuildId: typeof resolveBuildId
}

/** Install the current Chrome for Testing Stable and point the cached `stable` alias at it. */
export const installChrome = async ({ platform, cacheDir, install, resolveBuildId }: InstallChromeDeps) => {
  if (!platform) {
    throw new Error(`Chrome for Testing does not support ${process.platform}/${process.arch}`)
  }
  const buildId = await resolveBuildId(Browser.CHROME, platform, BrowserTag.STABLE)
  const browser = await install({
    cacheDir,
    browser: Browser.CHROME,
    platform,
    buildId,
    buildIdAlias: BrowserTag.STABLE,
    downloadProgressCallback: 'default',
  })
  // install() returns before updating aliases on a cache hit (@puppeteer/browsers 3.2.6); drop this once it doesn't.
  const metadata = browser.readMetadata()
  browser.writeMetadata({ ...metadata, aliases: { ...metadata.aliases, stable: buildId } })
  return { buildId, executablePath: browser.executablePath }
}

if (import.meta.main) {
  if (process.argv.includes('--with-deps') && process.platform === 'linux') {
    await $`bunx playwright install-deps chromium`
  }
  const { buildId, executablePath } = await installChrome({
    platform: detectBrowserPlatform(),
    cacheDir: getChromeCacheDir(),
    install,
    resolveBuildId,
  })
  console.log(`Chrome Stable ${buildId}: ${executablePath}`)
  if (process.env.GITHUB_ENV) {
    appendFileSync(process.env.GITHUB_ENV, `THUNDERBOLT_CHROME_EXECUTABLE=${executablePath}\n`)
  }
}
