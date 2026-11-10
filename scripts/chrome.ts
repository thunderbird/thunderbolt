/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Browser, BrowserTag, computeExecutablePath } from '@puppeteer/browsers'

/** Keep Stable Chrome alongside Playwright's other engines, including shared QA caches. */
export const getChromeCacheDir = (
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home = homedir(),
): string => {
  // Same rules as playwright-core's registryDirectory: an empty variable counts as unset, and a relative path
  // starts at INIT_CWD.
  if (env.PLAYWRIGHT_BROWSERS_PATH === '0') {
    return resolve(dirname(fileURLToPath(import.meta.url)), '../node_modules/.cache/stable-chrome')
  }
  if (env.PLAYWRIGHT_BROWSERS_PATH) {
    return resolve(env.INIT_CWD || process.cwd(), env.PLAYWRIGHT_BROWSERS_PATH, 'stable-chrome')
  }
  if (platform === 'darwin') {
    return join(home, 'Library/Caches/ms-playwright/stable-chrome')
  }
  if (platform === 'win32') {
    return join(env.LOCALAPPDATA || join(home, 'AppData/Local'), 'ms-playwright/stable-chrome')
  }
  return join(env.XDG_CACHE_HOME || join(home, '.cache'), 'ms-playwright/stable-chrome')
}

/** Resolve the installed Stable alias without network access or a fallback to bundled Chromium. */
export const getChromeExecutablePath = (cacheDir = getChromeCacheDir()): string =>
  computeExecutablePath({ cacheDir, browser: Browser.CHROME, buildId: BrowserTag.STABLE })

/** Use the independently refreshed Chrome Stable build in Playwright launches. */
export const getChromeLaunchOptions = () => ({ executablePath: getChromeExecutablePath() })

if (import.meta.main) {
  try {
    const executablePath = getChromeExecutablePath()
    if (!existsSync(executablePath)) {
      throw new Error(`Chrome for Testing Stable is not installed (${executablePath}).`)
    }
    console.log(executablePath)
  } catch (error) {
    console.error(error)
    console.error('Run `bun run browsers:install`.')
    process.exit(1)
  }
}
