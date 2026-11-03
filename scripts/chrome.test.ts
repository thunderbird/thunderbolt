/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getChromeCacheDir, getChromeExecutablePath } from './chrome'

const cacheDir = mkdtempSync(join(tmpdir(), 'thunderbolt-chrome-'))
afterAll(() => rmSync(cacheDir, { recursive: true, force: true }))

describe('Chrome cache', () => {
  test('shares an explicitly configured Playwright cache across OS users', () => {
    expect(getChromeCacheDir({ PLAYWRIGHT_BROWSERS_PATH: '/shared/browsers' }, 'linux', '/other-user')).toBe(
      '/shared/browsers/stable-chrome',
    )
  })

  test.each([
    ['macOS default', {}, 'darwin', '/home/Library/Caches/ms-playwright/stable-chrome'],
    ['Linux default', {}, 'linux', '/home/.cache/ms-playwright/stable-chrome'],
    ['XDG_CACHE_HOME', { XDG_CACHE_HOME: '/cache' }, 'linux', '/cache/ms-playwright/stable-chrome'],
    ['empty XDG_CACHE_HOME', { XDG_CACHE_HOME: '' }, 'linux', '/home/.cache/ms-playwright/stable-chrome'],
    ['LOCALAPPDATA', { LOCALAPPDATA: '/local' }, 'win32', '/local/ms-playwright/stable-chrome'],
    ['win32 without LOCALAPPDATA', {}, 'win32', '/home/AppData/Local/ms-playwright/stable-chrome'],
    [
      'relative PLAYWRIGHT_BROWSERS_PATH',
      { PLAYWRIGHT_BROWSERS_PATH: 'browsers', INIT_CWD: '/repo' },
      'linux',
      '/repo/browsers/stable-chrome',
    ],
  ] as const)('%s', (_, env, platform, expected) => {
    expect(getChromeCacheDir(env, platform, '/home')).toBe(expected)
  })

  test('keeps PLAYWRIGHT_BROWSERS_PATH=0 inside the checkout', () => {
    expect(getChromeCacheDir({ PLAYWRIGHT_BROWSERS_PATH: '0' }, 'linux', '/home')).toBe(
      join(import.meta.dir, '../node_modules/.cache/stable-chrome'),
    )
  })

  test('resolves an updated Stable alias even when the Playwright version stays fixed', () => {
    mkdirSync(join(cacheDir, 'chrome'), { recursive: true })
    const metadata = join(cacheDir, 'chrome/.metadata')
    writeFileSync(metadata, JSON.stringify({ aliases: { stable: '156.0.8078.80' } }))
    expect(getChromeExecutablePath(cacheDir)).toContain('156.0.8078.80')
    writeFileSync(metadata, JSON.stringify({ aliases: { stable: '156.0.8078.81' } }))
    expect(getChromeExecutablePath(cacheDir)).toContain('156.0.8078.81')
  })

  test('the CLI fails instead of printing a path to a missing Chrome', () => {
    const result = Bun.spawnSync(['bun', join(import.meta.dir, 'chrome.ts')], {
      env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: join(cacheDir, 'empty') },
    })
    expect(result.exitCode).toBe(1)
    expect(result.stdout.toString()).toBe('')
    expect(result.stderr.toString()).toContain('bun run browsers:install')
  })

  test.each(['darwin', 'linux'])('extended %s projects keep Chrome launch options out of other engines', (platform) => {
    const result = Bun.spawnSync(
      [
        'bun',
        '-e',
        `
      import config from './playwright.extended.config.ts'
      console.log(JSON.stringify(config.projects.map(({ name, use }) => ({ name, executablePath: use?.launchOptions?.executablePath }))))
    `,
      ],
      {
        cwd: join(import.meta.dir, '..'),
        env: {
          ...process.env,
          EXTENDED_PLATFORM: platform,
          EXTENDED_DATABASE_URL: 'postgresql://test@localhost/test',
          EXTENDED_POWERSYNC_URL: 'http://localhost:8080',
        },
      },
    )
    expect(result.exitCode).toBe(0)
    const projects = JSON.parse(result.stdout.toString()) as { name: string; executablePath?: string }[]
    expect(projects.length).toBeGreaterThan(0)
    for (const project of projects) {
      if (project.name.includes('chromium')) {
        expect(project.executablePath).toBe(getChromeExecutablePath())
      } else {
        expect(project.executablePath).toBeUndefined()
      }
    }
  })
})
