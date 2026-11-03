/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { appendFileSync } from 'node:fs'
import { Browser, BrowserTag, detectBrowserPlatform, install, resolveBuildId } from '@puppeteer/browsers'
import { $ } from 'bun'
import { getChromeCacheDir } from './chrome'

const platform = detectBrowserPlatform()
if (!platform) {
  throw new Error(`Chrome for Testing does not support ${process.platform}/${process.arch}`)
}

if (process.argv.includes('--with-deps') && process.platform === 'linux') {
  await $`bunx playwright install-deps chromium`
}

const buildId = await resolveBuildId(Browser.CHROME, platform, BrowserTag.STABLE)
const browser = await install({
  cacheDir: getChromeCacheDir(),
  browser: Browser.CHROME,
  platform,
  buildId,
  buildIdAlias: BrowserTag.STABLE,
  downloadProgressCallback: 'default',
})
// install() returns early on a cache hit, before updating aliases.
const metadata = browser.readMetadata()
browser.writeMetadata({ ...metadata, aliases: { ...metadata.aliases, stable: buildId } })

console.log(`Chrome Stable ${buildId}: ${browser.executablePath}`)
if (process.env.GITHUB_ENV) {
  appendFileSync(process.env.GITHUB_ENV, `THUNDERBOLT_CHROME_EXECUTABLE=${browser.executablePath}\n`)
}
