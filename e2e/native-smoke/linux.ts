/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict'
import { createServer, type ServerResponse } from 'node:http'
import { resolve } from 'node:path'
import { Key, remote } from 'webdriverio'
import { browserBannerPrompt, browserBannerReply, browserBannerThinking, fakeProviderReply } from '../fake-provider'
import type { BrowserSnapshot } from '../../src/browser/types'

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

/** Exercise native commands through the desktop webview's public Tauri bridge. */
const invokeNative = (command: string, args: Record<string, unknown> = {}) =>
  browser.execute(
    (command, args) => {
      const native = window as unknown as {
        __TAURI__: { core: { invoke: (command: string, args: Record<string, unknown>) => Promise<unknown> } }
      }
      return native.__TAURI__.core.invoke(command, args)
    },
    command,
    args,
  )

type NativeBrowserState = {
  url: string
  title: string
  isLoading: boolean
  canGoBack: boolean
  canGoForward: boolean
}

/** Menus in the composer must hand off to their siblings without stacking. */
const exerciseComposerMenus = async () => {
  const location = await browser.$('button[aria-label="Agent location"]')
  const access = await browser.$('button[aria-label="Agent access"]')
  for (const [next, previous] of [
    [location, access],
    [access, location],
    [location, access],
  ]) {
    await next.click()
    await browser.waitUntil(async () => (await next.getAttribute('aria-expanded')) === 'true')
    await browser.waitUntil(async () => (await previous.getAttribute('aria-expanded')) === 'false')
    assert.equal(await browser.execute(() => document.querySelectorAll('[role="menu"][data-state="open"]').length), 1)
  }
  const composer = await browser.$('textarea')
  await composer.click()
  await browser.waitUntil(async () =>
    browser.execute(() => document.querySelectorAll('[role="menu"][data-state="open"]').length === 0),
  )
  assert(await composer.isFocused(), 'Dismissing a menu should let the user type into the composer immediately')
  await access.click()
  await browser.keys(Key.Escape)
  await browser.waitUntil(async () => (await access.getAttribute('aria-expanded')) === 'false')
  assert(await access.isFocused(), 'Escape should restore focus to the menu trigger')
}

/** App dialogs and detail asides occupy the chat pane while a native page remains visible. */
const exerciseBrowserOverlayBoundary = async (activePanel: string) => {
  const originalBrowserBounds = await browser.execute((selector) => {
    const bounds = document.querySelector(selector)!.getBoundingClientRect()
    return { left: bounds.left, width: bounds.width }
  }, activePanel)
  const projectOptions = await browser.$('button[aria-label="Project options"]')
  await (
    (await projectOptions.isExisting()) ? projectOptions : await browser.$('button[aria-label="Projects"]')
  ).click()
  await (await browser.$('[role="menuitem"]=New project')).click()
  const dialog = await browser.$('[data-slot="dialog-content"]')
  await dialog.waitForDisplayed()
  await browser.waitUntil(
    async () => {
      return browser.execute(() => {
        const host = document.querySelector('[data-slot="app-content-overlay-host"]')!
        const bounds = host.getBoundingClientRect()
        const dialog = host.querySelector('[data-slot="dialog-content"]')?.getBoundingClientRect()
        const backdrop = host.querySelector('[data-slot="dialog-overlay"]')?.getBoundingClientRect()
        return Boolean(
          dialog &&
          backdrop &&
          dialog.left >= bounds.left &&
          dialog.right <= bounds.right &&
          Math.abs(dialog.left + dialog.width / 2 - (bounds.left + bounds.width / 2)) < 2 &&
          Math.abs(backdrop.left - bounds.left) < 1 &&
          Math.abs(backdrop.right - bounds.right) < 1,
        )
      })
    },
    { timeoutMsg: 'Create project and its backdrop should be centered inside the main content pane' },
  )
  await (await dialog.$('button=Cancel')).click()
  await dialog.waitForDisplayed({ reverse: true })

  await (await browser.$('[data-testid="agent-selector-trigger"]')).click()
  await (await browser.$('button=Add Agent')).click()
  const aside = await browser.$('[data-slot="app-content-overlay-host"] [data-slot="slide-in-panel"]')
  await aside.waitForDisplayed()
  await browser.waitUntil(
    async () =>
      browser.execute((selector) => {
        const host = document.querySelector('[data-slot="app-content-overlay-host"]')!
        const bounds = host.getBoundingClientRect()
        const aside = host.querySelector('[data-slot="slide-in-panel"]')?.getBoundingClientRect()
        const browserBounds = document.querySelector(selector)!.getBoundingClientRect()
        return Boolean(
          aside &&
          aside.width > 0 &&
          aside.left >= bounds.left &&
          aside.right <= bounds.right &&
          Math.abs(browserBounds.left - aside.right) < 1,
        )
      }, activePanel),
    { timeoutMsg: 'The detail aside should overlay the main pane and meet the browser divider without a gap' },
  )
  const browserBounds = await browser.execute((selector) => {
    const bounds = document.querySelector(selector)!.getBoundingClientRect()
    return { left: bounds.left, width: bounds.width }
  }, activePanel)
  assert.deepEqual(browserBounds, originalBrowserBounds, 'App overlays must not move or resize the browser')
  const surfaceAlpha = await browser.execute(() => {
    const surface = document.querySelector('[data-slot="app-content-overlay-host"] [data-slot="detail-panel-surface"]')!
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = 1
    const context = canvas.getContext('2d')!
    context.fillStyle = getComputedStyle(surface).backgroundColor
    context.fillRect(0, 0, 1, 1)
    return context.getImageData(0, 0, 1, 1).data[3]
  })
  assert.equal(surfaceAlpha, 255, 'The aside must have an opaque background over chat content')
  await (await aside.$('button[aria-label="Close details"]')).click()
  await aside.waitForDisplayed({ reverse: true })
}

/** The browser toggle has equal top/right insets at the window edge or the actual divider. */
const assertBrowserToggleGeometry = async () => {
  await browser.waitUntil(
    async () =>
      browser.execute(() => {
        const toggle = document.querySelector('[data-browser-toggle]')
        const header = document.querySelector('[data-main-header]')
        if (!header || !toggle || toggle.closest('[data-sidebar]')) {
          return false
        }
        const button = toggle.getBoundingClientRect()
        const windowControls = document.querySelector('[aria-label="Window controls"]')?.getBoundingClientRect()
        const divider = document.querySelector('[data-slot="resizable-handle"]')?.getBoundingClientRect()
        const browserOpen = toggle.getAttribute('aria-pressed') === 'true'
        const rightEdge = browserOpen ? divider?.right : (windowControls?.left ?? window.innerWidth)
        return (
          rightEdge !== undefined &&
          Math.abs(rightEdge - button.right - 8) <= 1 &&
          Math.abs(button.top - header.getBoundingClientRect().top - 8) <= 1 &&
          (!windowControls || button.right <= windowControls.left) &&
          toggle.contains(document.elementFromPoint(button.right - 2, button.top + button.height / 2))
        )
      }),
    { timeoutMsg: 'The browser toggle should have equal 8px top/right spacing and remain clickable at the pane edge' },
  )
}

/** Check balanced tab spacing and resize from the widened gutter outside the visible grip. */
const exerciseBrowserChrome = async (activePanel: string) => {
  await assertBrowserToggleGeometry()
  await browser.waitUntil(
    async () =>
      browser.execute(
        () =>
          document.querySelector('[data-slot="resizable-handle"]')?.getAttribute('data-native-resize-ready') === 'true',
      ),
    { timeoutMsg: 'The native grip should appear above browser page surfaces' },
  )
  const metrics = await browser.execute((selector) => {
    const strip = document.querySelector<HTMLElement>(`${selector} [data-browser-tab-strip]`)!
    const activeTab = strip.querySelector('[aria-selected="true"]')!.closest('[data-browser-tab]')!
    const separator = document.querySelector<HTMLElement>('[data-slot="resizable-handle"]')!
    const grip = separator.querySelector<HTMLElement>('[data-slot="resizable-handle-grip"]')!
    const stripStyle = getComputedStyle(strip)
    const tabStyle = getComputedStyle(activeTab)
    const bounds = separator.getBoundingClientRect()
    const gripBounds = grip.getBoundingClientRect()
    const dividerStyle = getComputedStyle(separator, '::after')
    const actions = [...strip.querySelectorAll('[data-browser-tab-actions] button')].map((button) =>
      button.getBoundingClientRect(),
    )
    const actionGaps = actions.slice(1).map((button, index) => button.left - actions[index].right)
    const history = [...document.querySelectorAll<HTMLButtonElement>('[data-main-header] button')].filter((button) =>
      ['Go back', 'Go forward'].includes(button.textContent?.trim() ?? ''),
    )
    const sidebarToggle = [...document.querySelectorAll<HTMLButtonElement>('button')].find((button) =>
      ['Toggle Sidebar', 'Collapse Sidebar'].includes(button.textContent?.trim() ?? ''),
    )!
    const search = document.querySelector<HTMLElement>('button[aria-label="Search"]')!
    return {
      actionGaps,
      historyRounded:
        history.length === 2 &&
        history.every(
          (button) =>
            parseFloat(getComputedStyle(button).borderTopLeftRadius) >= button.getBoundingClientRect().width / 2,
        ),
      sidebarRadius: getComputedStyle(sidebarToggle).borderTopLeftRadius,
      searchRadius: getComputedStyle(search).borderTopLeftRadius,
      padding: [stripStyle.paddingTop, stripStyle.paddingRight, stripStyle.paddingBottom, stripStyle.paddingLeft],
      gap: getComputedStyle(strip.querySelector('[role="tablist"]')!).columnGap,
      borders: [
        tabStyle.borderTopWidth,
        tabStyle.borderRightWidth,
        tabStyle.borderBottomWidth,
        tabStyle.borderLeftWidth,
      ],
      x: bounds.left,
      y: bounds.top + Math.min(120, bounds.height / 4),
      width: bounds.width,
      lineWidth: dividerStyle.width,
      lineRight: dividerStyle.right,
      lineTranslate: dividerStyle.translate,
      browserEdgeGap: strip.getBoundingClientRect().left - bounds.right,
      cursor: getComputedStyle(separator).cursor,
      gripWidth: gripBounds.width,
      gripHeight: gripBounds.height,
      gripCenterOffset: gripBounds.left + gripBounds.width / 2 - (bounds.right - 0.5),
      gripWindowCenterOffset: gripBounds.top + gripBounds.height / 2 - window.innerHeight / 2,
      gripRightX: gripBounds.right - 4,
      gripCenterY: gripBounds.top + gripBounds.height / 2,
      hasGripIcon: Boolean(grip.querySelector('.lucide-grip-vertical')),
    }
  }, activePanel)
  assert(metrics.historyRounded, 'App history buttons should be circular')
  assert.equal(metrics.sidebarRadius, metrics.searchRadius, 'Sidebar toggle should match the other sidebar buttons')
  assert.equal(metrics.actionGaps.length, 3)
  assert(
    Math.max(...metrics.actionGaps) - Math.min(...metrics.actionGaps) < 1,
    'All four tab actions should be evenly spaced',
  )
  assert(
    metrics.padding.every((padding) => padding === metrics.gap),
    'Tabs should have equal surrounding space',
  )
  assert(
    metrics.borders.every((width) => width === '0px'),
    'The active tab should have no border',
  )
  assert(
    metrics.width >= 24 && metrics.gripWidth >= 24 && metrics.gripHeight >= 40,
    'The resize grip should be easy to grab',
  )
  assert.equal(metrics.lineWidth, '1px', 'The wider resize gutter should retain a thin divider')
  assert.equal(metrics.lineRight, '0px', 'The divider should sit at the browser edge of the grab area')
  assert.equal(parseFloat(metrics.lineTranslate), 0, 'The divider should not shift away from the browser edge')
  assert(Math.abs(metrics.browserEdgeGap) < 1, 'There should be no empty gutter between the divider and browser')
  assert(Math.abs(metrics.gripCenterOffset) < 1, 'The resize grip should be centered over the divider line')
  assert(Math.abs(metrics.gripWindowCenterOffset) < 1, 'The resize grip should be vertically centered in the window')
  assert(metrics.hasGripIcon, 'The visible grip should retain its original drag icon')
  assert.equal(metrics.cursor, 'col-resize', 'The resize cursor should show opposing arrows with a line between them')

  const x = Math.round(metrics.x + 2)
  const y = Math.round(metrics.y)
  await browser
    .action('pointer', { id: 'browser-resize' })
    .move({ x, y })
    .down()
    .move({ x: x - 60, y, duration: 400 })
    .perform(true)
  try {
    await browser.waitUntil(
      async () => browser.execute(() => getComputedStyle(document.querySelector('textarea')!).cursor === 'col-resize'),
      {
        timeoutMsg: 'The column resize cursor should persist while dragging across the chat',
      },
    )
  } finally {
    await browser.action('pointer', { id: 'browser-resize' }).up().perform()
  }
  const separator = await browser.$('[data-slot="resizable-handle"]')
  await browser.waitUntil(async () => (await separator.getLocation('x')) < metrics.x - 30, {
    timeoutMsg: 'Dragging the outer resize gutter should resize the browser',
  })
  const movedX = Math.round((await separator.getLocation('x')) + 2)
  await browser
    .action('pointer')
    .move({ x: movedX, y })
    .down()
    .move({ x: movedX + 60, y, duration: 400 })
    .up()
    .perform()
  await browser.waitUntil(async () => Math.abs((await separator.getLocation('x')) - metrics.x) < 3)

  // The native grip overlaps the page surface; its right half must remain visible and draggable.
  const gripX = Math.round(metrics.gripRightX)
  const gripY = Math.round(metrics.gripCenterY)
  await browser
    .action('pointer')
    .move({ x: gripX, y: gripY })
    .down()
    .move({ x: gripX - 40, y: gripY, duration: 400 })
    .up()
    .perform()
  await browser.waitUntil(async () => (await separator.getLocation('x')) < metrics.x - 20, {
    timeoutMsg: 'The right half of the centered grip should resize the browser',
  })
  const movedGripX = Math.round(metrics.gripRightX + (await separator.getLocation('x')) - metrics.x)
  await browser
    .action('pointer')
    .move({ x: movedGripX, y: gripY })
    .down()
    .move({ x: movedGripX + 40, y: gripY, duration: 400 })
    .up()
    .perform()
  await browser.waitUntil(async () => Math.abs((await separator.getLocation('x')) - metrics.x) < 3)
}

/** Exercise native tabs, page history, element references, and browser chrome against local pages. */
const exerciseBrowser = async () => {
  const pendingLinks = new Set<ServerResponse>()
  const pendingPicks = new Set<ServerResponse>()
  const visits = new Map<string, number>()
  const receivedCookies = new Map<string, string>()
  const sessionCookie = `browser-smoke-session=${crypto.randomUUID()}`
  const fixture = createServer((request, response) => {
    const path = new URL(request.url ?? '/', 'http://localhost').pathname
    visits.set(path, (visits.get(path) ?? 0) + 1)
    receivedCookies.set(path, request.headers.cookie ?? '')
    response.setHeader('Cache-Control', 'no-store')
    if (path === '/follow-link') {
      pendingLinks.add(response)
      response.on('close', () => pendingLinks.delete(response))
      return
    }
    if (path === '/pick-element') {
      pendingPicks.add(response)
      response.on('close', () => pendingPicks.delete(response))
      return
    }
    if (path === '/redirect') {
      response.writeHead(302, { Location: '/two' }).end()
      return
    }
    if (path === '/site-icon.svg') {
      response.setHeader('Content-Type', 'image/svg+xml')
      response.end(
        '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16" rx="4" fill="#7655dd"/></svg>',
      )
      return
    }
    response.setHeader('Content-Type', 'text/html; charset=utf-8')
    if (path === '/one') {
      response.setHeader('Set-Cookie', `${sessionCookie}; Path=/; HttpOnly; SameSite=Lax`)
      response.end(`<!doctype html><title>Browser smoke one</title>
        <h1>First page</h1><a id="next" href="/redirect" target="_blank">Next page</a>
        <script>fetch('/follow-link').then(() => document.getElementById('next').click())</script>`)
      return
    }
    if (path === '/two') {
      response.end(`<!doctype html><title>Browser smoke two</title><link rel="icon" href="/site-icon.svg" type="image/svg+xml">
        <script>window.nativeRuntimeAtStartup = ['isTauri', '__TAURI__', '__TAURI_INTERNALS__', '__TAURI_OS_PLUGIN_INTERNALS__'].filter(name => name in window);</script>
        <style>body{min-height:2400px}input,button{display:block;margin:16px;padding:10px}</style>
        <h1>Second page</h1>
        <p id="runtime-isolation"></p>
        <a id="pick-target" href="/one">First page</a>
        <input aria-label="Native entry" value="Replace this"/>
        <button id="agent-target">Native click target</button>
        <p id="input-event"></p><p id="key-event"></p><p id="click-event"></p>
        <script>
          document.getElementById('runtime-isolation').textContent = window.nativeRuntimeAtStartup.length
            ? 'Native runtime leaked: ' + window.nativeRuntimeAtStartup.join(',') : 'Web runtime isolated';
          const entry = document.querySelector('input');
          entry.addEventListener('input', event => document.getElementById('input-event').textContent = 'Input trusted: ' + event.isTrusted);
          entry.addEventListener('keydown', event => document.getElementById('key-event').textContent = 'Key trusted: ' + event.isTrusted + ' ' + event.key);
          document.getElementById('agent-target').addEventListener('click', event => document.getElementById('click-event').textContent = 'Click trusted: ' + event.isTrusted);
          fetch('/pick-element').then(() => document.getElementById('pick-target').click());
        </script>`)
      return
    }
    if (path === '/three') {
      response.end('<!doctype html><title>Browser smoke three</title><h1>Third page</h1>')
      return
    }
    response.writeHead(404).end()
  })
  await new Promise<void>((resolve, reject) => {
    fixture.once('error', reject)
    fixture.listen(0, '127.0.0.1', resolve)
  })
  const address = fixture.address()
  assert(address && typeof address !== 'string')
  const origin = `http://127.0.0.1:${address.port}`
  const firstUrl = `${origin}/one`
  const secondUrl = `${origin}/two`
  const thirdUrl = `${origin}/three`
  const activePanel = '[data-browser-tab-panel]:not([inert])'
  const control = (selector: string) => browser.$(`${activePanel} ${selector}`)
  const tab = (title: string) =>
    browser.$(`//*[@data-browser-tab-panel and not(@inert)]//*[@role="tab" and normalize-space()="${title}"]`)
  const getLabels = async () => {
    const webviews = (await invokeNative('plugin:webview|get_all_webviews')) as { label: string }[]
    return webviews.filter((webview) => webview.label.startsWith('sidebar-webview-')).map((webview) => webview.label)
  }
  const waitForPage = async (label: string, url: string, title: string) => {
    await browser.waitUntil(
      async () => {
        const state = (await invokeNative('browser_get_state', { label })) as NativeBrowserState
        return state.url === url && state.title === title && !state.isLoading
      },
      { timeout: 15_000, timeoutMsg: `Browser did not finish loading ${url}` },
    )
    await browser.waitUntil(async () => (await (await control('input[aria-label="Address"]')).getValue()) === url, {
      timeout: 5000,
      timeoutMsg: 'Address bar did not follow the native page URL',
    })
    await (await tab(title)).waitForDisplayed()
    await browser.waitUntil(async () => (await (await tab(title)).getAttribute('aria-selected')) === 'true')
  }
  const navigate = async (url: string) => {
    await (await control('input[aria-label="Address"]')).setValue(url)
    await browser.waitUntil(async () => await (await control('button[aria-label="Go"]')).isEnabled())
    await (await control('button[aria-label="Go"]')).click()
  }
  const waitForClosed = async () => {
    await browser.waitUntil(async () => (await getLabels()).length === 0, {
      timeout: 5000,
      timeoutMsg: 'Closing the browser left a native webview alive',
    })
    await browser.waitUntil(async () => !(await (await browser.$('[data-browser-panel]')).isExisting()))
  }
  const closeBrowser = async () => {
    await (await control('button[aria-label="Close browser"]')).click()
    await waitForClosed()
  }
  const observe = async (label: string, screenshot = false) =>
    (await invokeNative('browser_agent_snapshot', { label, screenshot })) as Omit<BrowserSnapshot, 'tabId'>
  /** Check the real native adapter, including trusted events rather than DOM-dispatched substitutes. */
  const exerciseAgentInput = async (label: string) => {
    const initial = await observe(label, true)
    assert(initial.text.includes('Web runtime isolated'), 'Remote page startup should not detect or receive Tauri APIs')
    assert(initial.capabilities?.nativeInput && initial.capabilities.screenshot)
    assert(initial.screenshot, 'The agent should receive a native viewport screenshot')
    const png = Buffer.from(initial.screenshot.data, 'base64')
    assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a')
    const width = png.readUInt32BE(16)
    const height = png.readUInt32BE(20)
    assert(width > 0 && height > 0, 'The screenshot should contain a nonempty image')
    assert(
      Math.abs(width / height - initial.viewport.width / initial.viewport.height) < 0.02,
      'The screenshot should represent the page viewport rather than the whole desktop',
    )
    const input = initial.elements.find((element) => element.name === 'Native entry')
    const target = initial.elements.find((element) => element.name === 'Native click target')
    assert(input && target, 'DOM observations should expose refs for the native input fixture')
    const composer = await browser.$('textarea')
    const draft = 'Keep typing in chat while the agent works'
    await composer.setValue(draft)
    await composer.click()
    const assertComposerFocus = async () => {
      assert.equal(
        await browser.execute(() => document.hasFocus() && document.activeElement?.tagName === 'TEXTAREA'),
        true,
        'Native browser input must preserve keyboard focus in the chat composer',
      )
      assert.equal(await composer.getValue(), draft, 'Agent input must not change the user draft')
    }
    const action = (action: Record<string, unknown>) => invokeNative('browser_agent_action', { label, action })
    await action({ type: 'click', ref: input.ref })
    await assertComposerFocus()
    await action({ type: 'type', ref: input.ref, text: 'Native café ✓', clear: true })
    await browser.waitUntil(async () =>
      (await observe(label)).elements.some((element) => element.ref === input.ref && element.value === 'Native café ✓'),
    )
    await assertComposerFocus()
    await action({ type: 'key', key: 'Enter' })
    await action({ type: 'move', ref: target.ref })
    await action({ type: 'click', ref: target.ref })
    await browser.waitUntil(
      async () => {
        const page = await observe(label)
        return ['Input trusted: true', 'Key trusted: true Enter', 'Click trusted: true'].every((event) =>
          page.text.includes(event),
        )
      },
      { timeoutMsg: 'Native browser input should generate trusted click, text, and keyboard events' },
    )
    await assertComposerFocus()
    await action({ type: 'key', key: 'Escape' })
    await action({ type: 'key', key: 'Escape' })
    await browser.waitUntil(async () => (await observe(label)).text.includes('Key trusted: true Escape'))
    await browser.pause(100) // Let WebKit's asynchronous unhandled-key replay reach the native guard.
    await assertComposerFocus()
    const beforeScroll = (await observe(label)).viewport.scrollY
    await action({ type: 'scroll', deltaY: 400 })
    await browser.waitUntil(async () => (await observe(label)).viewport.scrollY > beforeScroll)
    await assertComposerFocus()
    await browser.keys(' still in chat')
    assert.equal(await composer.getValue(), `${draft} still in chat`, 'User typing must still enter the chat composer')
    await composer.setValue('')
    return { documentId: initial.documentId, ref: target.ref }
  }

  try {
    await assertBrowserToggleGeometry()
    await (await browser.$('button[aria-label="Open browser"]')).click()
    await (await control('[data-browser-new-tab]')).waitForDisplayed()
    assert.equal(await (await control('[data-page-external-address]')).isExisting(), false)
    assert.equal(await (await control('input[aria-label="Address"]')).isDisplayed(), true)
    assert.equal(await (await control('button[aria-label="New tab"]')).isDisplayed(), true)
    assert.equal(await (await control('button[aria-label="Go"]')).isEnabled(), false)
    await (await control('input[aria-label="Address"]')).setValue('https://')
    assert.equal(await (await control('button[aria-label="Go"]')).isEnabled(), false)
    assert.equal(await (await control('input[aria-label="Address"]')).getAttribute('aria-invalid'), null)
    assert.equal(await (await control('[role="alert"]')).isExisting(), false)
    await (await control('input[aria-label="Address"]')).setValue('')
    const labels = await getLabels()
    assert.equal(labels.length, 1)
    const label = labels[0]
    assert.equal(((await invokeNative('browser_get_state', { label })) as NativeBrowserState).url, 'about:blank')
    assert.equal(await (await control('input[aria-label="Address"]')).getValue(), '')
    await (await control('[data-browser-new-tab] img[alt="Thunderbolt"]')).waitForDisplayed()
    const logoRotation = await browser.execute(() => {
      const logo = document.querySelector<HTMLElement>('[data-browser-new-tab] img')!
      const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches
      const animation = logo.getAnimations()[0]
      if (reducedMotion || !animation) {
        return { reducedMotion, animated: Boolean(animation), widths: [], backface: '' }
      }
      const currentTime = animation.currentTime
      animation.pause()
      const widths = [0, 1000, 2000, 3000].map((time) => {
        animation.currentTime = time
        return logo.getBoundingClientRect().width
      })
      animation.currentTime = currentTime
      animation.play()
      return { reducedMotion, animated: true, widths, backface: getComputedStyle(logo).backfaceVisibility }
    })
    if (logoRotation.reducedMotion) {
      assert.equal(logoRotation.animated, false, 'The new-tab logo should stay still with reduced motion')
    } else {
      assert(logoRotation.animated, 'The new-tab logo should rotate')
      assert(logoRotation.widths[0] > 90 && logoRotation.widths[2] > 90, 'Both faces should have their full width')
      assert(logoRotation.widths[1] < 0.5 && logoRotation.widths[3] < 0.5, 'The logo should disappear edge-on twice')
      assert.equal(logoRotation.backface, 'visible', 'The reverse face should remain visible')
    }
    assert(
      (await (await control('[data-browser-new-tab]')).getText())
        .replace(/\s+/g, ' ')
        .includes('Enter a URL above or ask your agent to open a page.'),
    )
    await navigate(firstUrl)
    await waitForPage(label, firstUrl, 'Browser smoke one')

    // The fixture activates a real target=_blank link after the toolbar observes page one.
    // No test-only native eval or privileges are exposed to the child webview.
    await browser.waitUntil(() => pendingLinks.size > 0, { timeout: 5000 })
    for (const response of pendingLinks) {
      response.end('follow')
    }
    await browser.waitUntil(async () => (await getLabels()).length === 2, { timeout: 5000 })
    const secondLabel = (await getLabels()).find((candidate) => candidate !== label)
    assert(secondLabel)
    await waitForPage(secondLabel, secondUrl, 'Browser smoke two')
    await browser.waitUntil(
      async () =>
        browser.execute((selector) => {
          const icon = document.querySelector<HTMLImageElement>(
            `${selector} [role="tab"][aria-selected="true"] [data-browser-favicon]`,
          )
          return Boolean(icon?.src.endsWith('/site-icon.svg') && icon.complete && icon.naturalWidth > 0)
        }, activePanel),
      { timeout: 5000, timeoutMsg: 'The tab did not render its page-declared favicon after redirect' },
    )
    await exerciseBrowserOverlayBoundary(activePanel)
    await exerciseBrowserChrome(activePanel)
    const beforeExpand = await getLabels()
    const originalRoute = await browser.execute(() => location.pathname)
    await (await control('button[aria-label="Expand page"]')).click()
    await browser.waitUntil(async () => browser.execute(() => location.pathname.startsWith('/pages/')))
    assert.deepEqual((await getLabels()).sort(), beforeExpand.sort(), 'Expanding must retain the native webviews')
    await waitForPage(secondLabel, secondUrl, 'Browser smoke two')
    assert.equal(
      await (
        await browser.$$('[data-main-header]')
      ).length,
      0,
      'Expanded pages must not add a third header row',
    )
    const chrome = await browser.execute(() => {
      const header = document.querySelector('[data-page-header]')!.getBoundingClientRect()
      const address = document.querySelector('[data-page-address-row]')!.getBoundingClientRect()
      return {
        bottom: header.bottom,
        addressTop: address.top,
        draggable: Boolean(document.querySelector('[data-browser-tab-strip][data-tauri-drag-region]')),
      }
    })
    assert(Math.abs(chrome.bottom - chrome.addressTop) < 1, 'The address row must sit directly below the tabs')
    assert(chrome.draggable, 'The tab row must preserve native window dragging')
    assert.equal(
      await (
        await browser.$$('[data-browser-address-bar] [data-browser-page-navigation] button')
      ).length,
      3,
      'Website navigation belongs inside the address bar',
    )
    await (await control('button[aria-label="Restore to sidebar"]')).click()
    await browser.waitUntil(async () => (await browser.execute(() => location.pathname)) === originalRoute)
    assert.deepEqual((await getLabels()).sort(), beforeExpand.sort(), 'Restoring must retain the native webviews')
    const chatPath = await browser.execute(() => location.pathname)
    await (await browser.$('button[aria-label="Settings"]')).click()
    await (await browser.$('button=Preferences')).click()
    await browser.waitUntil(async () => browser.execute(() => location.pathname === '/settings/preferences'))
    await (await control('input[aria-label="Address"]')).waitForDisplayed()
    assert.deepEqual(
      (await getLabels()).sort(),
      [label, secondLabel].sort(),
      'Opening settings must preserve native browser tabs',
    )
    await waitForPage(secondLabel, secondUrl, 'Browser smoke two')
    await browser.back()
    await browser.waitUntil(async () => (await browser.execute(() => location.pathname)) === chatPath)
    assert.deepEqual(
      (await getLabels()).sort(),
      [label, secondLabel].sort(),
      'Returning to chat must reuse the browser sessions',
    )
    assert((visits.get('/redirect') ?? 0) > 0, 'The target=_blank link should follow its HTTP redirect')
    assert(receivedCookies.get('/two')?.includes(sessionCookie), 'Popup tabs should share the browser login session')
    assert.equal(((await invokeNative('browser_get_state', { label })) as NativeBrowserState).url, firstUrl)
    assert.equal(await (await control('button[aria-label="Go back"]')).isEnabled(), false)

    await (await tab('Browser smoke one')).click()
    await waitForPage(label, firstUrl, 'Browser smoke one')
    await navigate(thirdUrl)
    await waitForPage(label, thirdUrl, 'Browser smoke three')
    await (await control('button[aria-label="Go back"]')).click()
    await waitForPage(label, firstUrl, 'Browser smoke one')
    await browser.waitUntil(async () => await (await control('button[aria-label="Go forward"]')).isEnabled())
    await (await control('button[aria-label="Go forward"]')).click()
    await waitForPage(label, thirdUrl, 'Browser smoke three')
    assert.equal(
      ((await invokeNative('browser_get_state', { label: secondLabel })) as NativeBrowserState).url,
      secondUrl,
      'Navigating one tab must not change another tab',
    )
    await (await tab('Browser smoke two')).click()
    await waitForPage(secondLabel, secondUrl, 'Browser smoke two')
    assert.deepEqual((await getLabels()).sort(), [label, secondLabel].sort(), 'Switching tabs must retain native views')
    const previousDocument = await exerciseAgentInput(secondLabel)
    const beforeReload = visits.get('/two') ?? 0
    await (await control('button[aria-label="Reload page"]')).click()
    await browser.waitUntil(() => (visits.get('/two') ?? 0) > beforeReload, { timeout: 5000 })
    await waitForPage(secondLabel, secondUrl, 'Browser smoke two')
    assert.notEqual((await observe(secondLabel)).documentId, previousDocument.documentId)
    await assert.rejects(
      () =>
        invokeNative('browser_agent_action', {
          label: secondLabel,
          action: { type: 'click', ref: previousDocument.ref },
        }),
      /Stale element reference/,
      'Reloading a page must invalidate element refs from its previous document',
    )

    await (await tab('Browser smoke two')).click()
    await (await control('input[aria-label="Address"]')).click()
    assert.equal(
      await browser.execute((selector) => {
        const input = document.querySelector<HTMLInputElement>(selector)
        return Boolean(input && input.selectionStart === 0 && input.selectionEnd === input.value.length)
      }, `${activePanel} input[aria-label="Address"]`),
      true,
      'Focusing the address should select the full URL',
    )
    assert.equal(await (await control('button[aria-label="Bookmarks"]')).isExisting(), false)
    assert.equal(await (await control('button[aria-label="Bookmark this page"]')).isExisting(), false)

    await (await control('button[aria-label="Select element"]')).click()
    await (await control('button[aria-label="Cancel selection"][aria-pressed="true"]')).waitForDisplayed()
    // Both operations use the same native tab queue. Reading the snapshot after the toolbar click
    // ensures the picker is installed before the fixture dispatches its ordinary page click.
    const snapshot = (await invokeNative('browser_agent_snapshot', { label: secondLabel, screenshot: false })) as {
      documentId: string
      elements: { ref: string; name: string }[]
    }
    const selectedElement = snapshot.elements.find((element) => element.name === 'First page')
    assert(selectedElement, 'The live browser snapshot should identify the fixture link')
    await browser.waitUntil(() => pendingPicks.size > 0, { timeout: 5000 })
    for (const response of pendingPicks) {
      response.end('pick')
    }
    const quote = await browser.$('button[title="View quote"]')
    await quote.waitForDisplayed({ timeout: 5000 })
    const quoteText = await quote.getText()
    assert(quoteText.includes('First page'))
    assert(quoteText.includes(selectedElement.ref), 'The quote should preserve the actionable document element ref')
    assert(quoteText.includes(`"url":"${secondUrl}"`), 'The quote should preserve the page provenance')
    assert(!quoteText.includes(`"tabId":"${secondLabel}"`), 'The quote should expose the public tab ID')
    await (await control('button[aria-label="Select element"]')).waitForDisplayed()
    assert.equal(
      ((await invokeNative('browser_get_state', { label: secondLabel })) as NativeBrowserState).url,
      secondUrl,
      'Picking a link should attach it without following it',
    )
    await (await browser.$('button[aria-label="Remove quote"]')).click()
    await (await control('button[aria-label="Select element"]')).click()
    await (await control('button[aria-label="Cancel selection"]')).click()
    await (await control('button[aria-label="Select element"]')).waitForDisplayed()

    await (await control('button[aria-label="New tab"]')).click()
    await browser.waitUntil(async () => (await getLabels()).length === 3, { timeout: 5000 })
    const thirdLabel = (await getLabels()).find((candidate) => candidate !== label && candidate !== secondLabel)
    assert(thirdLabel)
    await browser.waitUntil(async () => await (await control('input[aria-label="Address"]')).isFocused())
    assert.equal(await (await control('input[aria-label="Address"]')).getValue(), '')
    await (await control('[data-browser-new-tab] img[alt="Thunderbolt"]')).waitForDisplayed()
    await navigate(firstUrl)
    await waitForPage(thirdLabel, firstUrl, 'Browser smoke one')
    assert.equal(await (await control('[data-browser-new-tab]')).isExisting(), false)
    assert(receivedCookies.get('/one')?.includes(sessionCookie), 'Manually opened tabs should share the login session')
    await (await tab('Browser smoke three')).click({ button: 'right' })
    await (await browser.$('[role="menuitem"]=Close tab')).click()
    await browser.waitUntil(async () => (await getLabels()).length === 2, { timeout: 5000 })
    assert.deepEqual((await getLabels()).sort(), [secondLabel, thirdLabel].sort())
    await waitForPage(thirdLabel, firstUrl, 'Browser smoke one')

    await (await control('button[aria-label="Close tab Browser smoke one"]')).click()
    await browser.waitUntil(async () => (await getLabels()).length === 1, { timeout: 5000 })
    assert.deepEqual(await getLabels(), [secondLabel])
    await waitForPage(secondLabel, secondUrl, 'Browser smoke two')
    const beforeSessionReload = visits.get('/two') ?? 0
    await (await control('button[aria-label="Reload page"]')).click()
    await browser.waitUntil(() => (visits.get('/two') ?? 0) > beforeSessionReload, { timeout: 5000 })
    await waitForPage(secondLabel, secondUrl, 'Browser smoke two')
    assert(receivedCookies.get('/two')?.includes(sessionCookie), 'Closing the original tab must retain the session')
    await (await control('button[aria-label="Close tab Browser smoke two"]')).click()
    await waitForClosed()

    await (await browser.$('button[aria-label="Open browser"]')).click()
    await (await control('[data-browser-new-tab]')).waitForDisplayed()
    const reopenedLabels = await getLabels()
    assert.equal(reopenedLabels.length, 1)
    await navigate(secondUrl)
    await waitForPage(reopenedLabels[0], secondUrl, 'Browser smoke two')
    assert.equal(
      receivedCookies.get('/two')?.includes(sessionCookie),
      false,
      'Closing every tab should end the private browser session',
    )
    await closeBrowser()

    await (await browser.$('button[aria-label="Open browser"]')).click()
    await (await control('[data-browser-tab-empty]')).doubleClick()
    await browser.waitUntil(async () => (await getLabels()).length === 2, { timeout: 5000 })
    await browser.waitUntil(async () => await (await control('input[aria-label="Address"]')).isFocused())
    assert.equal(await (await control('input[aria-label="Address"]')).getValue(), '')
    await (await browser.$('[data-browser-toggle][aria-pressed="true"]')).click()
    await waitForClosed()
    assert.equal(await (await browser.$('[data-browser-toggle]')).getAttribute('aria-pressed'), 'false')
    await assertBrowserToggleGeometry()

    await (await browser.$('[data-browser-toggle]')).click()
    await (await control('[role="tab"]')).click({ button: 'right' })
    await (await browser.$('[role="menuitem"]=Close all tabs')).click()
    await waitForClosed()
    await browser.waitUntil(
      async () => browser.execute(() => document.getElementById('content-view')!.getBoundingClientRect().width < 1),
      {
        timeoutMsg: 'Closing all tabs must release the browser space',
      },
    )

    // The fake model opens and observes a real native tab, then waits between its
    // final text chunks. Activity must survive the gap after the tools returned.
    const composer = await browser.$('textarea')
    await composer.setValue(`${browserBannerPrompt}${secondUrl}`)
    await (await browser.$('button[aria-label="Send message"]')).click()
    await browser.waitUntil(async () => (await (await browser.$('body')).getText()).includes(browserBannerThinking), {
      timeout: 30_000,
      timeoutMsg: 'The browser fixture did not finish its native tool calls',
    })
    const banner = await control('[role="status"]')
    const bannerId = banner.elementId
    const observationStarted = Date.now()
    while (Date.now() - observationStarted < 1000) {
      assert.equal(await banner.isDisplayed(), true, 'The agent banner must remain visible between browser tool calls')
      assert((await banner.getText()).includes('Agent is using this tab'))
      assert.equal(
        (await control('[role="status"]')).elementId,
        bannerId,
        'The banner must stay mounted without flickering',
      )
      await browser.pause(100)
    }
    await browser.waitUntil(async () => (await (await browser.$('body')).getText()).includes(browserBannerReply), {
      timeout: 10_000,
    })
    await browser.waitUntil(async () => !(await (await control('[role="status"]')).isExisting()), {
      timeout: 10_000,
      timeoutMsg: 'The completed agent turn left its browser activity banner visible',
    })
    await closeBrowser()

    await (await browser.$(`a[href="${secondUrl}"]`)).click()
    const linkDialog = await browser.$('[role="alertdialog"]')
    await linkDialog.waitForDisplayed()
    const inApp = await linkDialog.$('button=Open in Thunderbolt')
    const external = await linkDialog.$('button=Open in Browser')
    assert(
      (await inApp.getLocation('x')) > (await external.getLocation('x')),
      'Thunderbolt should be the rightmost action',
    )
    assert((await inApp.getAttribute('class'))?.includes('bg-brand'), 'Thunderbolt should be the primary action')
    await (await inApp.$('svg rect[rx="5"]')).waitForExist()
    const rememberChoice = await linkDialog.$('[role="checkbox"]')
    assert.equal(
      await rememberChoice.getAttribute('aria-checked'),
      'false',
      'Remember my choice should start unchecked',
    )
    await rememberChoice.click()
    await inApp.click()
    await linkDialog.waitForDisplayed({ reverse: true })
    await browser.waitUntil(async () => (await getLabels()).length > 0)
    await waitForPage((await getLabels())[0], secondUrl, 'Browser smoke two')
    await closeBrowser()
    await (await browser.$(`a[href="${secondUrl}"]`)).click()
    await browser.waitUntil(async () => (await getLabels()).length > 0)
    assert.equal(
      await (await browser.$('[role="alertdialog"]')).isExisting(),
      false,
      'Remembered links should bypass the dialog',
    )
    await waitForPage((await getLabels())[0], secondUrl, 'Browser smoke two')
    // A renderer reload does not unmount React reliably; native chrome must not survive it.
    await browser.refresh()
    await (await browser.$('textarea')).waitForDisplayed({ timeout: 60_000 })
    await browser.waitUntil(
      async () => {
        const views = (await invokeNative('plugin:webview|get_all_webviews')) as { label: string }[]
        return !views.some((view) => view.label === 'browser-resize-handle')
      },
      { timeout: 5000, timeoutMsg: 'Reloading the app must remove its old native browser grip' },
    )
  } finally {
    fixture.closeAllConnections()
    await new Promise<void>((resolve, reject) => fixture.close((error) => (error ? reject(error) : resolve())))
  }
}

try {
  const email = await browser.$('input[placeholder="Email"]')
  await email.waitForDisplayed({ timeout: 60_000 })
  await email.setValue(`native-${crypto.randomUUID()}@thunderbolt.test`)
  await (await browser.$('//button[normalize-space()="Continue"]')).click()
  const otp = await browser.$('input[autocomplete="one-time-code"]')
  await otp.waitForDisplayed({ timeout: 30_000 })
  await otp.setValue('12345678')
  await (await browser.$('textarea')).waitForDisplayed({ timeout: 60_000 })

  const trayBeforeReload = await invokeNative('plugin:tray|get_by_id', { id: 'main-tray' })
  assert.equal(typeof trayBeforeReload, 'number', 'The desktop tray should be initialized')
  await Promise.all([
    invokeNative('initialize_tray', { showLabel: 'Show', quitLabel: 'Quit' }),
    invokeNative('initialize_tray', { showLabel: 'Show', quitLabel: 'Quit' }),
  ])
  await browser.refresh()
  const composer = await browser.$('textarea')
  await composer.waitForDisplayed({ timeout: 60_000 })
  const appReadyAt = Date.now()
  assert.equal(
    await invokeNative('plugin:tray|get_by_id', { id: 'main-tray' }),
    trayBeforeReload,
    'Reloading the frontend should retain the native tray',
  )

  await invokeNative('plugin:window|close', { label: 'main' })
  await browser.waitUntil(async () => (await invokeNative('plugin:window|is_visible', { label: 'main' })) === false)
  await invokeNative('show_main_window')
  await browser.waitUntil(async () => (await invokeNative('plugin:window|is_visible', { label: 'main' })) === true)

  await exerciseComposerMenus()
  await (await browser.$('[data-testid="model-selector-trigger"]')).click()
  const standardModel = await browser.$('//button[normalize-space()="Opus 5.5"]')
  await (await standardModel.$('[role="img"][aria-label="Thunderbolt"]')).waitForDisplayed()
  await standardModel.click()
  await browser.keys(Key.Escape)
  await composer.setValue('Please greet me briefly.')
  await (await browser.$('button[aria-label="Send message"]')).click()
  await browser.waitUntil(async () => (await (await browser.$('body')).getText()).includes(fakeProviderReply), {
    timeout: 60_000,
    timeoutMsg: `The chat reply did not render: ${fakeProviderReply}`,
  })
  await browser.pause(1000) // Keep the complete reply visible in the recording.
  await exerciseBrowser()
  await browser.waitUntil(() => Date.now() - appReadyAt >= 6000, { timeout: 10_000 })
  assert.equal((await (await browser.$('body')).getText()).includes('Update failed'), false)
  // eslint-disable-next-line no-console -- Report successful completion in the smoke-test runner output.
  console.log('Linux desktop smoke passed')
} finally {
  await browser.deleteSession()
}
