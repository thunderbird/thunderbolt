#!/usr/bin/env bun

/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The desktop shell lane: scripted checks of what only the real Tauri app on Linux does. No model runs here. Run it
// under Xvfb, with the stack of e2e/native-smoke/services.sh up and the debug app built; see "Desktop shell" in
// .github/qa/README.md.

import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { remote } from 'webdriverio'
import { fakeProviderReply } from '../../../e2e/fake-provider'
import type { LayoutProblem } from '../layout'

declare global {
  // Declaration merging needs an interface. `withGlobalTauri` in src-tauri/tauri.conf.json sets it.
  interface Window {
    __TAURI__: { core: { invoke: (command: string, args: Record<string, number>) => Promise<void> } }
  }
}

export type CheckResult = { name: string; error?: string }

/** The job summary, and whether the lane failed. */
export const summarize = (results: CheckResult[]) => ({
  failed: results.some((r) => r.error !== undefined),
  markdown: [
    '# Desktop shell (Tauri on Linux)',
    '',
    '| Check | Result |',
    '| --- | --- |',
    ...results.map(
      (r) =>
        `| ${r.name} | ${r.error === undefined ? 'passed' : `failed: ${r.error.replace(/\s+/g, ' ').replaceAll('|', '\\|')}`} |`,
    ),
  ].join('\n'),
})

const prompt = 'Please greet me briefly.'
const probe = await readFile(resolve(import.meta.dir, '../layout-probe.js'), 'utf8')
// A variable, as in e2e/native-smoke/linux.ts: webdriverio's type has no `tauri:options`.
const capabilities = {
  browserName: 'wry',
  'wdio:enforceWebDriverClassic': true,
  'tauri:options': { application: resolve('src-tauri/target/debug/thunderbolt') },
}

const launch = () => remote({ hostname: '127.0.0.1', port: 4444, logLevel: 'warn', capabilities })

type Browser = Awaited<ReturnType<typeof launch>>

const run = async (out: string) => {
  const home = await mkdtemp(join(tmpdir(), 'qa-desktop-'))
  const downloads = join(home, 'Downloads')
  const config = join(home, 'config')
  await mkdir(downloads)
  await mkdir(config)
  // `$DOWNLOAD` resolves through the XDG user dirs file, which a fresh config dir lacks.
  await writeFile(join(config, 'user-dirs.dirs'), `XDG_DOWNLOAD_DIR="${downloads}"\n`)
  // tauri-driver hands its environment to the app, so every launch, the relaunch included, shares this profile.
  const env = {
    ...process.env,
    XDG_CONFIG_HOME: config,
    XDG_DATA_HOME: join(home, 'data'),
    XDG_CACHE_HOME: join(home, 'cache'),
    // WebKitGTK otherwise paints a blank window under Xvfb.
    WEBKIT_DISABLE_COMPOSITING_MODE: '1',
  }
  const log = Bun.file(join(out, 'tauri-driver.log'))
  const driver = Bun.spawn(['tauri-driver', '--port', '4444'], { env, stdout: log, stderr: log })
  try {
    await waitForDriver()
    return await checks(out, downloads)
  } finally {
    driver.kill()
  }
}

const waitForDriver = async () => {
  for (let i = 0; i < 30; i++) {
    // nosemgrep: typescript.react.security.react-insecure-request.react-insecure-request -- loopback WebDriver status
    const ok = await fetch('http://127.0.0.1:4444/status').then(
      (r) => r.ok,
      () => false,
    )
    if (ok) return
    await Bun.sleep(1000)
  }
  throw new Error('tauri-driver did not start')
}

/** Runs a command and returns its stdout; a nonzero exit throws with its stderr. */
const sh = async (cmd: string[]) => {
  const proc = Bun.spawn(cmd, { stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  if (code !== 0) throw new Error(`${cmd.join(' ')} exited ${code}: ${stderr.trim()}`)
  return stdout
}

const waitForText = (browser: Browser, text: string, timeout: number) =>
  browser.waitUntil(async () => (await (await browser.$('body')).getText()).includes(text), {
    timeout,
    timeoutMsg: `"${text}" did not show`,
  })

const signIn = async (browser: Browser) => {
  const email = await browser.$('input[placeholder="Email"]')
  await email.waitForDisplayed({ timeout: 60_000 })
  await email.setValue(`desktop-${crypto.randomUUID()}@thunderbolt.test`)
  await (await browser.$('//button[normalize-space()="Continue"]')).click()
  const otp = await browser.$('input[autocomplete="one-time-code"]')
  await otp.waitForDisplayed({ timeout: 30_000 })
  await otp.setValue('12345678')
  await (await browser.$('textarea')).waitForDisplayed({ timeout: 60_000 })
}

/** The layout probe's confirmed problems on the current screen. */
const layoutProblems = async (browser: Browser): Promise<LayoutProblem[]> => {
  await browser.execute(probe)
  await browser.pause(1500)
  return browser.execute(() => window.__qaLayout.problems())
}

const checks = async (out: string, downloads: string): Promise<CheckResult[]> => {
  const results: CheckResult[] = []
  let browser = await launch()
  const check = async (name: string, body: () => Promise<void>) => {
    try {
      await body()
      results.push({ name })
    } catch (error) {
      results.push({ name, error: error instanceof Error ? error.message : String(error) })
      await browser.saveScreenshot(join(out, `${name.replaceAll(' ', '-')}.png`)).catch(() => undefined)
    }
  }
  try {
    await check('sign in', () => signIn(browser))
    if (results[0].error) return results

    await check('copy a reply to the X clipboard', async () => {
      await (await browser.$('[data-testid="model-selector-trigger"]')).click()
      await (await browser.$('//button[normalize-space()="Opus 5.5"]')).click()
      await (await browser.$('textarea')).setValue(prompt)
      await (await browser.$('button[aria-label="Send message"]')).click()
      await waitForText(browser, fakeProviderReply, 60_000)
      // The user message has its own copy button, shown only on hover; the reply's is the last.
      await (await browser.$('(//button[@aria-label="Copy message"])[last()]')).click()
      await browser.waitUntil(
        async () => (await sh(['xclip', '-o', '-selection', 'clipboard'])) === fakeProviderReply,
        {
          timeout: 10_000,
          timeoutMsg: 'the reply is not on the X clipboard',
        },
      )
    })

    // xdotool sends the key through X and GTK, as a keyboard does; WebDriver's keys start inside WebKit.
    await check('Ctrl+K from the X keyboard opens the search palette', async () => {
      await sh(['xdotool', 'key', 'ctrl+k'])
      await (await browser.$('[role="dialog"]')).waitForDisplayed({ timeout: 10_000 })
      await sh(['xdotool', 'key', 'Escape'])
    })

    // Under WebDriver, WebKit answers the file chooser itself and never opens the GTK dialog, so this fills the input.
    await check('an attached image shows its preview', async () => {
      await (await browser.$('input[type="file"]')).addValue(resolve(import.meta.dir, '../fixtures/sample.png'))
      try {
        const preview = await browser.$('img[alt="sample.png"]')
        await preview.waitForExist({ timeout: 10_000 })
        await browser.waitUntil(async () => (await preview.getProperty('naturalWidth')) !== 0, {
          timeout: 10_000,
          timeoutMsg: 'the preview image did not load (img-src in the CSP of src-tauri/tauri.conf.json?)',
        })
      } finally {
        await (await browser.$('button[aria-label="Remove sample.png"]')).click()
      }
    })

    await check('Export My Data saves to the Downloads folder', async () => {
      await browser.execute(() => {
        history.pushState(null, '', '/settings/preferences')
        dispatchEvent(new PopStateEvent('popstate'))
      })
      try {
        await (await browser.$('#export-data-button')).click()
        const exported = async () => (await readdir(downloads)).find((f) => f.startsWith('thunderbolt-export-'))
        await browser.waitUntil(async () => (await exported()) !== undefined, {
          timeout: 15_000,
          timeoutMsg: `no export file in ${downloads}`,
        })
        JSON.parse(await readFile(join(downloads, (await exported()) ?? ''), 'utf8'))
      } finally {
        // The next check measures the chat.
        await browser.execute(() => history.back())
      }
    })

    await check('the window stops at its 500px minimum width and the chat fits', async () => {
      await browser.setWindowSize(400, 800)
      const width = await browser.execute(() => window.innerWidth)
      if (width !== 500) throw new Error(`the window is ${width}px wide, not its 500px minimum`)
      if (!(await browser.execute(() => document.documentElement.classList.contains('force-desktop'))))
        throw new Error('<html> lost force-desktop')
      await waitForText(browser, fakeProviderReply, 10_000)
      // The dev config has no updater endpoints, so launches show "Update failed", which covers the composer here.
      const dismiss = await browser.$('button[aria-label="Dismiss"]')
      if (await dismiss.isDisplayed()) await dismiss.click()
      const problems = await layoutProblems(browser)
      if (problems.length > 0) throw new Error(problems.map((p) => `${p.kind} ${p.target}`).join('; '))
    })

    // The app's own quit (the tray's Quit), then a fresh launch on the same profile.
    await check('quit and reopen keeps the account and the chat', async () => {
      await browser.execute(() => {
        void window.__TAURI__.core.invoke('plugin:process|exit', { code: 0 })
      })
      await browser.deleteSession().catch(() => undefined)
      browser = await launch()
      await (await browser.$('textarea')).waitForDisplayed({ timeout: 60_000 })
      // The chat's title in Recents; the relaunch lands on a new chat.
      await (
        await browser.$(`//*[normalize-space()="${prompt}"]`)
      ).waitForDisplayed({
        timeout: 30_000,
        timeoutMsg: `the chat "${prompt}" is not in Recents after the relaunch`,
      })
    })
    return results
  } finally {
    await browser.deleteSession().catch(() => undefined)
  }
}

if (import.meta.main) {
  const { values } = parseArgs({ options: { out: { type: 'string' } } })
  if (!values.out) throw new Error('usage: desktop.ts --out <dir>')
  await mkdir(values.out, { recursive: true })
  const { failed, markdown } = summarize(await run(values.out))
  console.log(markdown)
  if (Bun.env.GITHUB_STEP_SUMMARY) await writeFile(Bun.env.GITHUB_STEP_SUMMARY, `${markdown}\n`, { flag: 'a' })
  process.exit(failed ? 1 : 0)
}
