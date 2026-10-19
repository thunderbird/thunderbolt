/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Pins the layout probe's rules on static pages. The probe loads as an init script, as the explore agent's browser
// loads it, so it sees each page from its first paint.
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, test, type Page } from '@playwright/test'
import { layoutProblems } from '../layout'

const probePath = resolve(import.meta.dirname, '../layout-probe.js')
const fixture = (name: string) => pathToFileURL(resolve(import.meta.dirname, '../fixtures/layout', name)).href

const problemsOf = async (page: Page, name: string) => {
  await page.addInitScript({ path: probePath })
  await page.goto(fixture(name))
  return layoutProblems(page)
}

const consoleLines = (page: Page) => {
  const lines: string[] = []
  page.on('console', (message) => {
    if (message.type() === 'error' && message.text().startsWith('[qa-layout]')) lines.push(message.text())
  })
  return lines
}

test('a clean form has no problems', async ({ page }) => expect(await problemsOf(page, 'ok.html')).toEqual([]))

test('a fixed footer over a button is covered', async ({ page }) =>
  expect(await problemsOf(page, 'covered.html')).toEqual([{ kind: 'covered', target: 'button "Continue"' }]))

test('a button pushed out of a fixed container is offscreen', async ({ page }) =>
  expect(await problemsOf(page, 'offscreen.html')).toEqual([{ kind: 'offscreen', target: 'button "Save"' }]))

test('a button below the fold of a scrollable page is fine', async ({ page }) =>
  expect(await problemsOf(page, 'scrollable.html')).toEqual([]))

test('the background of a modal is not covered', async ({ page }) =>
  expect(await problemsOf(page, 'modal.html')).toEqual([]))

test('an overlay that leaves after 200 ms is never reported', async ({ page }) => {
  const lines = consoleLines(page)
  expect(await problemsOf(page, 'transient.html')).toEqual([])
  expect(lines.filter((line) => line.startsWith('[qa-layout] covered'))).toEqual([])
})

test('an inline alert over a button is covered, unlike a toast', async ({ page }) => {
  // Scrolling moves the alert with the button, so the room the page has below does not excuse it.
  await page.setContent(`
    <div style="height: 600px"></div>
    <button>Retry</button>
    <p role="alert" style="position: relative; margin-top: -20px; background: #fee">Failed</p>
    <div style="height: 2000px"></div>`)
  expect(await layoutProblems(page)).toEqual([{ kind: 'covered', target: 'button "Retry"' }])
})

test('unbreakable text wider than a phone overflows', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  expect((await problemsOf(page, 'overflow.html')).map((problem) => problem.kind).sort()).toEqual([
    'overflow-page',
    'overflow-text',
  ])
})

test('a focused field under the keyboard is reported', async ({ page }) => {
  // fake-keyboard.js replaces window.visualViewport with one 300 px shorter than the window before the probe starts.
  // The dialog under the popover still counts, and so does its disabled button.
  expect(await problemsOf(page, 'keyboard.html')).toEqual([
    { kind: 'behind-keyboard', target: 'textbox "Name"' },
    { kind: 'behind-keyboard', target: 'button "Continue"' },
  ])
})

test('with no dialog open, the focused field form buttons count', async ({ page }) =>
  expect(await problemsOf(page, 'keyboard-form.html')).toEqual([
    { kind: 'behind-keyboard', target: 'button "Subscribe"' },
  ]))

test('a fixed bar over the lower edge of the focused field is focus-covered, though its center is free', async ({
  page,
}) =>
  expect(await problemsOf(page, 'focus-covered.html')).toEqual([{ kind: 'focus-covered', target: 'textbox "Name"' }]))

test('an icon inside a focused search field is not a cover', async ({ page }) =>
  expect(await problemsOf(page, 'in-field-icon.html')).toEqual([]))

test('a focused field partly under the keyboard is behind-keyboard, though the page could scroll it clear', async ({
  page,
}) =>
  expect(await problemsOf(page, 'keyboard-partial.html')).toEqual([
    { kind: 'behind-keyboard', target: 'textbox "Email"' },
  ]))

test('a focused field its scroll box cuts off with the keyboard open is focused-clipped, though the box has room', async ({
  page,
}) =>
  expect(await problemsOf(page, 'focused-clipped.html')).toEqual([
    { kind: 'focused-clipped', target: 'textbox "Enter your name"' },
  ]))

test('a focused textarea taller than its box above the keyboard is not reported', async ({ page }) =>
  expect(await problemsOf(page, 'focused-tall.html')).toEqual([]))

test('a focused textarea taller than the screen above the keyboard is not behind-keyboard', async ({ page }) => {
  await page.setContent(`<textarea aria-label="Instructions" style="display: block; height: 600px"></textarea>`)
  await page.addScriptTag({ path: resolve(import.meta.dirname, '../fixtures/layout/fake-keyboard.js') })
  expect(await layoutProblems(page)).toEqual([])
})

test('a focused field past both its box and the keyboard line is focused-clipped once', async ({ page }) => {
  // The box ends at 400 px, above the 420 px keyboard line, and cuts the field before the keyboard does.
  await page.setContent(`
    <body style="margin: 0">
      <div id="box" style="height: 100px; margin-top: 300px; overflow-y: auto">
        <div style="height: 80px"></div>
        <input placeholder="City" style="display: block; height: 44px" />
        <div style="height: 30px"></div>
      </div>
    </body>`)
  await page.addScriptTag({ path: resolve(import.meta.dirname, '../fixtures/layout/fake-keyboard.js') })
  await page.evaluate(() => document.getElementById('box')?.scrollTo(0, 0))
  expect(await layoutProblems(page)).toEqual([{ kind: 'focused-clipped', target: 'textbox "City"' }])
})

test('a focused field scrolled fully into its box is not clipped', async ({ page }) => {
  await problemsOf(page, 'focused-clipped.html')
  await page.evaluate(() => document.querySelector('input')?.scrollIntoView({ block: 'nearest' }))
  expect(await layoutProblems(page)).toEqual([])
})

test('a focused field clipped only while it scrolls into view is never reported', async ({ page }) => {
  const lines = consoleLines(page)
  await page.addInitScript({ path: probePath })
  await page.goto(`${fixture('focused-clipped.html')}#scrolls`)
  expect(await layoutProblems(page)).toEqual([])
  expect(lines).toEqual(['[qa-layout] ready'])
})

test('a fixed box over a field behind-keyboard reports is still focus-covered', async ({ page }) =>
  expect(await problemsOf(page, 'keyboard-cover.html')).toEqual([
    { kind: 'behind-keyboard', target: 'textbox "Name"' },
    { kind: 'focus-covered', target: 'textbox "Name"' },
  ]))

// The field's top 10 px sit under the header, and the page has 140 px of room to scroll back up.
const stickyHeaderPage = `
  <body style="margin: 0">
    <header style="position: sticky; top: 0; height: 60px; background: #ddd">Header</header>
    <div style="height: 140px"></div>
    <input placeholder="Title" style="display: block; height: 44px" />
    <div style="height: 2000px"></div>
    <script>
      document.querySelector('input').focus()
      scrollTo(0, 150)
    </script>
  </body>`

test('a sticky header over a focused field is fine while the page can scroll it clear', async ({ page }) => {
  await page.setContent(stickyHeaderPage)
  expect(await layoutProblems(page)).toEqual([])
})

test('with the keyboard open, a sticky header over the focused field is focus-covered despite the room', async ({
  page,
}) => {
  await page.setContent(stickyHeaderPage)
  await page.addScriptTag({ path: resolve(import.meta.dirname, '../fixtures/layout/fake-keyboard.js') })
  await page.evaluate(() => scrollTo(0, 150))
  expect(await layoutProblems(page)).toEqual([{ kind: 'focus-covered', target: 'textbox "Title"' }])
})

test('a page that never stops changing is still measured', async ({ page }) => {
  await page.setContent(`
    <span id="clock"></span>
    <button style="position: fixed; bottom: 10px">Send</button>
    <div style="position: fixed; bottom: 0; width: 100%; height: 60px; background: #ddd"></div>
    <script>setInterval(() => (document.getElementById('clock').textContent = Date.now()), 100)</script>`)
  expect(await layoutProblems(page)).toEqual([{ kind: 'covered', target: 'button "Send"' }])
})

test('each problem is logged once, after one ready line', async ({ page }) => {
  const lines = consoleLines(page)
  await problemsOf(page, 'covered.html')
  // A second copy on the same page (a repro spec's layoutProblems) and the page's iframe stay silent, and a problem
  // that goes away and comes back is not logged again.
  await page.addScriptTag({ path: probePath })
  await page.evaluate(() => document.getElementById('footer')?.remove())
  expect(await layoutProblems(page)).toEqual([])
  await page.evaluate(() => document.body.insertAdjacentHTML('beforeend', '<div id="footer">Footer</div>'))
  expect(await layoutProblems(page)).toEqual([{ kind: 'covered', target: 'button "Continue"' }])
  expect(lines).toEqual(['[qa-layout] ready', '[qa-layout] covered button "Continue"'])
})

test('scrolling the page measures it again', async ({ page }) => {
  await problemsOf(page, 'covered.html')
  await page.evaluate(() => scrollTo(0, 0))
  expect(await layoutProblems(page)).toEqual([])
})

test('layoutProblems injects the probe into a page that lacks it', async ({ page }) => {
  await page.goto(fixture('covered.html'))
  expect(await layoutProblems(page)).toEqual([{ kind: 'covered', target: 'button "Continue"' }])
})
