/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Key, remote, type ChainablePromiseElement } from 'webdriverio'
import { z } from 'zod'
import { fakeProviderReply } from '../fake-provider'
import { clickButton, completeSetup } from './setup-wizard'

// linux.sh runs this once per setup choice, each from a fresh install.
const setup = z.enum(['local', 'cloud']).parse(process.argv[2])

const capabilities = {
  browserName: 'wry',
  'wdio:enforceWebDriverClassic': true,
  'tauri:options': { application: resolve('src-tauri/target/debug/thunderbolt') },
}

const browser = await remote({
  hostname: '127.0.0.1',
  port: 4444,
  logLevel: 'warn',
  capabilities,
})

/** What the native commands this smoke calls take and return: a tray id, a visibility flag, or nothing. */
const nativeValueSchema = z.union([z.string(), z.number(), z.boolean(), z.null()])
type NativeValue = z.infer<typeof nativeValueSchema>

/** Exercise native commands through the desktop webview's public Tauri bridge. */
const invokeNative = async (command: string, args: Record<string, NativeValue> = {}): Promise<NativeValue> =>
  nativeValueSchema.parse(
    await browser.execute('return window.__TAURI__.core.invoke(arguments[0], arguments[1])', command, args),
  )

/** Drive the X pointer and keyboard as a person would. */
const xdotool = (...args: string[]) => execFileSync('xdotool', args)

/** Offer `path` the way a file manager does, or a link the way a browser does (see file-source.py), while `act` runs. */
const whileOffering = async (
  mode: 'drag' | 'copy' | 'drag-link' | 'copy-link',
  path: string,
  act: () => Promise<void>,
) => {
  const source = Bun.spawn(['python3', 'e2e/native-smoke/file-source.py', mode, path])
  try {
    assert.equal((await source.stdout.getReader().read()).done, false, `file-source.py ${mode} exited early`)
    await act()
  } finally {
    source.kill()
    await source.exited
  }
}

/** Drag the offered file from file-source.py's window onto the composer with real X pointer input. */
const dragOnto = async (composer: ChainablePromiseElement) => {
  const frame = await browser.getWindowRect()
  const box = await browser.getElementRect(await composer.elementId)
  // Under Xvfb the window has no frame, so the page starts at the window's corner.
  const to = { x: frame.x + box.x + box.width / 2, y: frame.y + box.y + box.height / 2 }
  // file-source.py puts its 120-pixel window at the screen's top-left corner. GTK starts a drag only once the
  // pointer moves, and the app follows it only while it keeps moving, so the pointer travels in steps.
  const steps = Array.from({ length: 20 }, (_, step) => {
    const at = (from: number, end: number) => String(Math.round(from + ((end - from) * (step + 1)) / 20))
    return ['mousemove', at(60, to.x), at(60, to.y), 'sleep', '0.05']
  })
  xdotool('mousemove', '60', '60', 'mousedown', '1', 'sleep', '0.3', ...steps.flat(), 'sleep', '0.5', 'mouseup', '1')
}

/** Wait for the chip of an attached file, then remove it so the next check starts from an empty composer. */
const removeAttachment = async (name: string) => {
  const remove = await browser.$(`button[aria-label="Remove ${name}"]`)
  await remove.waitForClickable({ timeout: 30_000 })
  await remove.click()
  await remove.waitForExist({ reverse: true })
}

/** Attach files in the two ways WebKitGTK hides from the page: a drag and a paste from a file manager. */
const attachFromFileManager = async (composer: ChainablePromiseElement) => {
  const folder = mkdtempSync(join(tmpdir(), 'native-smoke-'))
  const file = (name: string) => {
    const path = join(folder, name)
    writeFileSync(path, 'Native smoke attachment.\n')
    return path
  }
  await whileOffering('drag', file('dragged.txt'), async () => {
    await dragOnto(composer)
    await removeAttachment('dragged.txt')
  })
  await whileOffering('copy', file('pasted.txt'), async () => {
    await composer.click()
    xdotool('key', 'ctrl+v')
    await removeAttachment('pasted.txt')
  })
  // The native drop handler takes a dragged link from the page, and GTK reads a link offered as bare text/plain as
  // empty, so the composer types both links itself.
  const link = 'https://example.com/native-smoke?x=1'
  for (const mode of ['drag-link', 'copy-link'] as const) {
    await whileOffering(mode, link, async () => {
      await composer.click()
      if (mode === 'drag-link') {
        await dragOnto(composer)
      } else {
        xdotool('key', 'ctrl+v')
      }
      await browser.waitUntil(async () => (await composer.getValue()) !== '', {
        timeout: 30_000,
        timeoutMsg: `A link from ${mode} was not typed into the composer`,
      })
      await browser.pause(500) // A second insertion would land right after the first.
      assert.equal(await composer.getValue(), link, `A link from ${mode} should be typed once, unchanged`)
      xdotool('key', 'ctrl+a', 'BackSpace')
    })
  }
  const locked = file('locked.txt')
  chmodSync(locked, 0)
  assert.throws(() => readFileSync(locked), 'Run the smoke as a user that file permissions apply to')
  await whileOffering('drag', locked, async () => {
    await dragOnto(composer)
    await browser.waitUntil(
      async () => (await (await browser.$('body')).getText()).includes(`Couldn't read "locked.txt".`),
      { timeout: 30_000, timeoutMsg: 'An unreadable file was not reported' },
    )
  })
}

try {
  // A fresh install opens the setup wizard. Reload it here: under tauri-driver a reload drops the app's
  // data and brings back a fresh install, so a reload after setup would undo it.
  await (await browser.$('#terms-agreement')).waitForDisplayed({ timeout: 60_000 })
  const trayBeforeReload = await invokeNative('plugin:tray|get_by_id', { id: 'main-tray' })
  assert.ok(Number.isInteger(trayBeforeReload), 'The desktop tray should be initialized')
  await Promise.all([
    invokeNative('initialize_tray', { showLabel: 'Show', quitLabel: 'Quit' }),
    invokeNative('initialize_tray', { showLabel: 'Show', quitLabel: 'Quit' }),
  ])
  await browser.refresh()
  await (await browser.$('#terms-agreement')).waitForDisplayed({ timeout: 60_000 })
  assert.equal(
    await invokeNative('plugin:tray|get_by_id', { id: 'main-tray' }),
    trayBeforeReload,
    'Reloading the frontend should retain the native tray',
  )

  await completeSetup(browser, setup)
  const composer = await browser.$('textarea')
  const appReadyAt = Date.now()
  assert.equal(
    await (await browser.$('section[aria-label="Security notice"]')).isExisting(),
    false,
    'A new account must not show the recovery banner',
  )

  await invokeNative('plugin:window|close', { label: 'main' })
  await browser.waitUntil(async () => (await invokeNative('plugin:window|is_visible', { label: 'main' })) === false)
  await invokeNative('show_main_window')
  await browser.waitUntil(async () => (await invokeNative('plugin:window|is_visible', { label: 'main' })) === true)

  if (setup === 'local') {
    // The model added during setup is already the chat's model. Wait for it: the window has just come back.
    await (
      await browser.$('//*[@data-testid="model-selector-trigger"][contains(., "Fake Model")]')
    ).waitForDisplayed({ timeout: 30_000 })
  } else {
    // The backend routes Anthropic models to the fake provider; the default model is not faked.
    await (await browser.$('[data-testid="model-selector-trigger"]')).click()
    const standardModel = await browser.$('//button[normalize-space()="Opus 5.5"]')
    await (await standardModel.$('[role="img"][aria-label="Thunderbolt"]')).waitForDisplayed()
    await standardModel.click()
    await browser.keys(Key.Escape)
  }
  const previewUrl = 'https://example.invalid/native-preview-check'
  await composer.setValue(`Please greet me briefly. [Preview safety check](${previewUrl})`)
  await (await browser.$('button[aria-label="Send message"]')).click()
  await browser.waitUntil(async () => (await (await browser.$('body')).getText()).includes(fakeProviderReply), {
    timeout: 60_000,
    timeoutMsg: `The chat reply did not render: ${fakeProviderReply}`,
  })
  await browser.pause(1000) // Keep the complete reply visible in the recording.
  await browser.waitUntil(() => Date.now() - appReadyAt >= 6000, { timeout: 10_000 })
  assert.equal((await (await browser.$('body')).getText()).includes('Update failed'), false)
  if (setup === 'local') {
    // Attaching does not depend on the setup choice, so one pass covers it.
    await attachFromFileManager(composer)
  }

  // Linux must never put an external page in a native sidebar webview (THU-1042).
  await (await browser.$(`a[href="${previewUrl}"]`)).click()
  const linkDialog = await browser.$('[role="alertdialog"]')
  await linkDialog.waitForDisplayed({ timeout: 10_000 })
  assert.equal(
    await (await linkDialog.$('//button[normalize-space()="Open in Sidebar"]')).isExisting(),
    false,
    'Linux link confirmation must not offer a native sidebar',
  )
  assert.ok(
    await (await linkDialog.$('//button[normalize-space()="Open Link"]')).isDisplayed(),
    'Linux link confirmation must offer external opening',
  )
  await (await linkDialog.$('//button[normalize-space()="Cancel"]')).click()
  // Navigate in the app: a page load would drop the app's data and reopen the setup wizard (see the reload above).
  const settings = await browser.$('nav[aria-label="Sidebar sections"] button[aria-label^="Settings"]')
  await settings.waitForClickable({ timeout: 30_000 })
  await settings.click()
  await clickButton(browser, 'Preferences')
  const ask = await browser.$('[role="radio"][aria-label="Always ask"]')
  await ask.waitForDisplayed({ timeout: 30_000 })
  assert.equal(
    await (await browser.$('[role="radio"][aria-label="Open in sidebar"]')).isExisting(),
    false,
    'Linux must not offer external sidebar webviews',
  )
  const openInBrowser = await browser.$('[role="radio"][aria-label="Open in browser"]')
  await openInBrowser.click()
  assert.equal(await openInBrowser.getAttribute('data-state'), 'on', 'The Linux browser preference was not selected')
  await ask.click()
  // eslint-disable-next-line no-console -- Report successful completion in the smoke-test runner output.
  console.log(`Linux desktop smoke passed (${setup})`)
} finally {
  await browser.deleteSession()
}
