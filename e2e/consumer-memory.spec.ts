/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { Locator, Page } from '@playwright/test'
import { expect, test } from './test'
import { collectPageErrors, loginViaEmailCode } from './helpers'

test.use({ locale: 'en-US' })

/** Use the same overflow action as the other connection detail panels. */
const editFromAside = async (page: Page, aside: Locator) => {
  await aside.getByRole('button', { name: 'More', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Edit', exact: true }).click()
}

test('cold and warm memory asides animate continuously through opening, closing, and reopening', async ({
  page,
}, testInfo) => {
  const errors = collectPageErrors(page)
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  const requested = new Set<string>()
  const hostGate = Promise.withResolvers<void>()
  const panelGate = Promise.withResolvers<void>()
  await page.route(/\/src\/components\/create-item\/create-item-host\.tsx(?:\?|$)/, async (route) => {
    requested.add('host')
    await hostGate.promise
    await route.continue()
  })
  await page.route(/\/src\/settings\/memory\/memory-document-panel\.tsx(?:\?|$)/, async (route) => {
    requested.add('panel')
    await panelGate.promise
    await route.continue()
  })
  try {
    await loginViaEmailCode(page)
    await page.goto('/settings/memory')
    await page.getByRole('switch', { name: 'Saved memories', exact: true }).click()
    const view = page.getByRole('button', { name: 'View full memory', exact: true })
    const surface = page.locator('aside[data-slot="slide-in-panel"]')
    const fullMemory = page.getByRole('document', { name: 'Memory text', exact: true })
    const trace = await page.evaluateHandle(() => {
      const elements: Element[] = []
      const state = {
        running: true,
        phase: 'cold',
        samples: [] as { phase: string; width: number; identity: number }[],
      }
      const sample = () => {
        if (!state.running) {
          return
        }
        const element = document.querySelector('aside[data-slot="slide-in-panel"]')
        if (element) {
          if (!elements.includes(element)) {
            elements.push(element)
          }
          state.samples.push({
            phase: state.phase,
            width: element.getBoundingClientRect().width,
            identity: elements.indexOf(element),
          })
        }
        requestAnimationFrame(sample)
      }
      requestAnimationFrame(sample)
      return state
    })
    // Let the provider's opening frames elapse while each lazy layer is still blocked.
    const advancePaints = () =>
      page.evaluate(async () => {
        for (const frame of [0, 1, 2, 3]) {
          await new Promise<number>((resolve) => requestAnimationFrame(() => resolve(frame)))
        }
      })
    const waitForMotion = () =>
      expect
        .poll(() =>
          surface.evaluate(
            (element) => element.getAnimations().filter((animation) => animation.playState === 'running').length,
          ),
        )
        .toBe(0)
    await view.click()
    await expect.poll(() => requested.has('host')).toBe(true)
    await advancePaints()
    await expect(surface).toHaveCount(0)
    hostGate.resolve()
    await expect.poll(() => requested.has('panel')).toBe(true)
    await advancePaints()
    await expect(surface).toHaveCount(0)
    panelGate.resolve()
    await expect(fullMemory).toBeVisible()
    await waitForMotion()
    const fullWidth = (await surface.boundingBox())!.width
    await trace.evaluate((state) => {
      state.phase = 'closing'
    })
    await surface.getByRole('button', { name: 'Close details', exact: true }).click()
    await expect(surface).toHaveCount(0)
    await trace.evaluate((state) => {
      state.phase = 'warm'
    })
    await view.click()
    await expect(fullMemory).toBeVisible()
    await waitForMotion()
    const samples = await trace.evaluate((state) => {
      state.running = false
      return state.samples
    })
    await testInfo.attach('memory-aside-motion.json', {
      body: JSON.stringify(samples),
      contentType: 'application/json',
    })
    for (const phase of ['cold', 'warm', 'closing']) {
      const frames = samples.filter((sample) => sample.phase === phase)
      expect(new Set(frames.map((sample) => sample.identity)).size).toBe(1)
      expect(frames.filter(({ width }) => width > 1 && width < fullWidth - 1).length).toBeGreaterThanOrEqual(2)
      for (const [index, frame] of frames.entries()) {
        const previous = frames[index - 1]
        if (!previous) {
          continue
        }
        if (phase === 'closing') {
          expect(frame.width).toBeLessThanOrEqual(previous.width + 1)
        } else {
          expect(frame.width).toBeGreaterThanOrEqual(previous.width - 1)
        }
      }
    }
    expect(errors).toEqual([])
  } finally {
    hostGate.resolve()
    panelGate.resolve()
  }
})

test('built-in preview opens a full memory aside for Markdown, editing, copy, cancel, and clear', async ({
  page,
  context,
  browserName,
}) => {
  const errors = collectPageErrors(page)
  await loginViaEmailCode(page)
  await page.goto('/settings/memory')
  const text = page.getByRole('textbox', { name: 'Memory text', exact: true })
  const memoryDocument = page.getByRole('document', { name: 'Memory text', exact: true })
  const providerSection = page.getByRole('region', { name: 'Memory provider', exact: true })
  const aside = page.locator('aside[data-slot="slide-in-panel"][aria-hidden="false"]')
  const memoryToggle = page.getByRole('switch', { name: 'Saved memories', exact: true })
  const historyToggle = page.getByRole('switch', { name: 'Reference earlier chats', exact: true })
  const view = providerSection.getByRole('button', { name: 'View full memory', exact: true })
  const edit = providerSection.getByRole('button', { name: 'Edit', exact: true })
  const builtIn = page.getByRole('radio', { name: 'Built-in', exact: true })
  await expect(view).toBeVisible()
  const divider = providerSection.locator('.h-px')
  await expect(divider).toBeVisible()
  expect((await divider.boundingBox())!.height).toBe(1)
  expect(await divider.evaluate((element) => getComputedStyle(element).backgroundColor)).not.toBe('rgba(0, 0, 0, 0)')
  await expect(memoryDocument).toHaveCount(0)
  await expect(text).toHaveCount(0)
  await expect(page.getByRole('region', { name: 'Saved memory', exact: true })).toHaveCount(0)
  await expect(builtIn).toBeChecked()
  expect(await builtIn.evaluate((element) => getComputedStyle(element).backgroundImage)).toContain('linear-gradient')
  await expect(page.getByRole('combobox', { name: 'Model for compaction' })).toHaveCount(0)
  for (const description of [
    'Allow agents to recall and share info across sessions. Not used by private chats.',
    'Allow agents to view previous chat sessions.',
  ]) {
    const descriptionText = page.getByText(description, { exact: true })
    await expect(descriptionText).toBeVisible()
    expect(await descriptionText.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true)
  }
  await expect(memoryToggle).not.toBeChecked()
  await expect(historyToggle).not.toBeChecked()
  await expect(edit).toBeDisabled()
  await expect(view).toBeDisabled()
  await expect(page.getByRole('button', { name: 'Add connection', exact: true })).toBeDisabled()
  await expect(builtIn).toBeDisabled()
  expect(await providerSection.evaluate((element) => getComputedStyle(element.closest('fieldset')!).opacity)).toBe(
    '0.5',
  )
  await memoryToggle.click()
  await expect(memoryToggle).toBeChecked()
  await builtIn.click()
  await expect(aside).toHaveCount(0)
  // Hit-test the disabled action: it must not fall through to the card's View overlay.
  const compact = providerSection.getByRole('button', { name: 'Compact', exact: true })
  await expect(compact).toBeDisabled()
  const compactBounds = (await compact.boundingBox())!
  await page.mouse.click(compactBounds.x + compactBounds.width / 2, compactBounds.y + compactBounds.height / 2)
  await expect(aside).toHaveCount(0)
  await view.click()
  await expect(aside.getByRole('heading', { name: 'Built-in memory', exact: true })).toBeVisible()
  await expect(memoryDocument).toBeVisible()
  await expect(text).toHaveCount(0)
  await expect(aside.getByText('0 characters', { exact: true })).toBeVisible()
  await expect(aside.getByRole('button', { name: 'Compact', exact: true })).toHaveCount(0)
  await expect(aside.getByRole('button', { name: 'Edit', exact: true })).toHaveCount(0)
  await editFromAside(page, aside)
  await expect(text).toBeEditable()
  await expect(memoryDocument).toHaveCount(0)
  await expect(aside.getByRole('button', { name: 'Edit', exact: true })).toHaveCount(0)
  expect(await text.evaluate((element) => element.getBoundingClientRect().height)).toBeGreaterThanOrEqual(380)
  const save = aside.getByRole('button', { name: 'Save', exact: true })
  const cancel = aside.getByRole('button', { name: 'Cancel', exact: true })
  const saveBounds = (await save.boundingBox())!
  const cancelBounds = (await cancel.boundingBox())!
  const textBounds = (await text.boundingBox())!
  expect(saveBounds.y).toBeGreaterThanOrEqual(textBounds.y + textBounds.height)
  expect(saveBounds.x).toBeGreaterThan(cancelBounds.x)
  expect(await save.evaluate((element) => element.nextElementSibling)).toBeNull()
  const preferences = '# QA preferences\n\n- Use **Celsius** unless I request Fahrenheit.\n- Keep answers concise.'
  // A family emoji and a combining accent each count as one visible character.
  const content = `${preferences}\n\n👩‍👩‍👧‍👦 e\u0301`
  const count = `${preferences.length + 5} characters`
  await text.fill(content)
  const editingMore = aside.getByRole('button', { name: 'More', exact: true })
  await expect(editingMore).toBeVisible()
  await expect(editingMore).toBeEnabled()
  await editingMore.click()
  await expect(page.getByRole('menuitem', { name: 'Edit', exact: true })).toBeDisabled()
  await expect(page.getByRole('textbox', { name: 'Memory text', exact: true, includeHidden: true })).toHaveValue(
    content,
  )
  await page.getByRole('menu').press('Escape')
  await expect(page.getByRole('menu')).toHaveCount(0)
  await expect(text).toHaveValue(content)
  await expect(aside.getByText(count, { exact: true })).toBeVisible()
  await save.click()
  await expect(aside.getByRole('button', { name: 'More', exact: true })).toBeEnabled()
  await expect(text).toHaveCount(0)
  await expect(memoryDocument.getByRole('heading', { name: 'QA preferences', level: 1 })).toBeVisible()
  await expect(memoryDocument.getByRole('listitem')).toHaveText([
    'Use Celsius unless I request Fahrenheit.',
    'Keep answers concise.',
  ])
  await expect(memoryDocument.locator('strong')).toHaveText('Celsius')
  const titleColor = await aside
    .getByRole('heading', { name: 'Built-in memory', exact: true })
    .evaluate((element) => getComputedStyle(element).color)
  expect(
    await memoryDocument
      .getByRole('listitem')
      .first()
      .evaluate((element) => getComputedStyle(element).color),
  ).not.toBe(titleColor)
  const selectedText = await memoryDocument.evaluate((element) => {
    const range = window.document.createRange()
    range.selectNodeContents(element)
    const selection = window.getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
    return selection.toString()
  })
  expect(selectedText).toContain('Use Celsius unless I request Fahrenheit.')
  expect(selectedText).not.toContain('**Celsius**')
  const copy = aside.getByRole('button', { name: 'Copy', exact: true })
  await expect(copy).toHaveText('')
  const copyBounds = (await copy.boundingBox())!
  const countBounds = (await aside.getByText(count, { exact: true }).boundingBox())!
  expect(copyBounds.x).toBeGreaterThan(countBounds.x)
  if (browserName === 'chromium') {
    await context.grantPermissions(['clipboard-read', 'clipboard-write'])
    await copy.click()
    await expect(aside.getByRole('button', { name: 'Copied', exact: true })).toBeVisible()
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(content)
  }
  await aside.getByRole('button', { name: 'Close details', exact: true }).click()
  await expect(aside).toHaveCount(0)
  const preview = providerSection.getByRole('heading', { name: 'QA preferences', exact: true })
  await expect(preview).toBeVisible()
  expect(
    await preview.evaluate((element) => element.parentElement!.getBoundingClientRect().height),
  ).toBeLessThanOrEqual(112)
  expect(await preview.evaluate((element) => getComputedStyle(element.parentElement!).overflow)).toBe('hidden')
  await page.reload()
  await expect(preview).toBeVisible()
  await expect(memoryDocument).toHaveCount(0)
  await edit.click()
  await expect(text).toHaveValue(content)
  await text.fill('Discard this draft')
  await cancel.click()
  await expect(text).toHaveCount(0)
  await expect(memoryDocument.locator('strong')).toHaveText('Celsius')
  await editFromAside(page, aside)
  await text.fill('Discard when closing')
  await aside.getByRole('button', { name: 'Close details', exact: true }).click()
  await expect(aside).toHaveCount(0)
  await edit.click()
  await expect(text).toHaveValue(content)
  await text.fill('Keep this draft while memory is off')
  await memoryToggle.click()
  await expect(memoryToggle).not.toBeChecked()
  await expect(text).toBeDisabled()
  await expect(text).toHaveValue('Keep this draft while memory is off')
  for (const name of ['Save', 'Cancel', 'Copy']) {
    await expect(aside.getByRole('button', { name, exact: true })).toBeDisabled()
  }
  await expect(view).toBeDisabled()
  await expect(builtIn).toBeDisabled()
  await historyToggle.click()
  await expect(historyToggle).toBeChecked()
  await memoryToggle.click()
  await expect(text).toBeEditable()
  await expect(text).toHaveValue('Keep this draft while memory is off')
  await cancel.click()
  await expect(memoryDocument.locator('strong')).toHaveText('Celsius')
  await editFromAside(page, aside)
  await text.fill('')
  await save.click()
  await expect(text).toHaveCount(0)
  await expect(memoryDocument).toBeVisible()
  await expect(aside.getByText('0 characters', { exact: true })).toBeVisible()
  await aside.getByRole('button', { name: 'Close details', exact: true }).click()
  await expect(aside).toHaveCount(0)
  await page.reload()
  await page.setViewportSize({ width: 390, height: 844 })
  const mobileAdd = page.getByRole('button', { name: 'Add connection', exact: true })
  await expect(mobileAdd).toHaveText('')
  expect(await mobileAdd.evaluate((element) => getComputedStyle(element).position)).not.toBe('fixed')
  await edit.click()
  const mobilePanel = page.getByRole('dialog')
  await expect(mobilePanel).toBeVisible()
  await expect(text).toHaveValue('')
  expect(await text.evaluate((element) => element.getBoundingClientRect().height)).toBeGreaterThanOrEqual(380)
  await text.fill('🧠'.repeat(1_600))
  await expect(mobilePanel.getByText('1,600 characters', { exact: true })).toBeVisible()
  await expect(mobilePanel.getByText('Memory is too long. Shorten it before saving.', { exact: true })).toBeVisible()
  await expect(mobilePanel.getByRole('button', { name: 'Save', exact: true })).toBeDisabled()
  await mobilePanel.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(mobilePanel.getByText('0 characters', { exact: true })).toBeVisible()
  await expect(memoryDocument).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  expect(errors).toEqual([])
})

test('one memory provider stays selected across reloads while its built-in preview remains available', async ({
  page,
}) => {
  const errors = collectPageErrors(page)
  await loginViaEmailCode(page)
  await page.goto('/settings/memory')
  const group = page.getByRole('radiogroup', { name: 'Memory provider', exact: true })
  const builtIn = group.getByRole('radio', { name: 'Built-in', exact: true })
  const text = page.getByRole('textbox', { name: 'Memory text', exact: true })
  const memoryDocument = page.getByRole('document', { name: 'Memory text', exact: true })
  const aside = page.locator('aside[data-slot="slide-in-panel"][aria-hidden="false"]')
  await expect(builtIn).toBeChecked()
  await page.getByRole('switch', { name: 'Saved memories', exact: true }).click()
  await group.getByRole('button', { name: 'Edit', exact: true }).click()
  const content = 'Keep this local document when switching providers.\nSecond line.'
  await text.fill(content)
  await aside.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(memoryDocument).toBeVisible()
  await aside.getByRole('button', { name: 'Close details', exact: true }).click()
  // Import an unavailable connection through the real UI without starting OAuth or provider requests.
  await page.goto('/settings/connections')
  await page.getByRole('button', { name: 'New Connection', exact: true }).click()
  await page.getByRole('button', { name: 'MCP server', exact: true }).click()
  await page.getByText('Advanced (JSON)', { exact: true }).click()
  await page.getByLabel('Servers JSON').fill(
    JSON.stringify({
      mcpServers: { 'QA Mem0 memory': { url: 'https://mcp.mem0.ai/mcp', disabled: true } },
    }),
  )
  await page.getByRole('button', { name: 'Import Servers', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Open QA Mem0 memory', exact: true })).toBeVisible()
  await page.goto('/settings/memory')
  await page.getByRole('button', { name: 'Manage QA Mem0 memory', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'QA Mem0 memory', exact: true })).toBeVisible()
  await expect(page.getByText('This connection is disabled.', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Enable connection', exact: true })).toBeEnabled()
  await expect(page.getByText('Server URL', { exact: true })).toHaveCount(0)
  await expect(page.getByText('Transport: HTTP', { exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: 'Close details', exact: true }).click()
  const external = group.getByRole('radio', { name: 'QA Mem0 memory', exact: true })
  await external.click()
  await expect(external).toBeChecked()
  await expect(builtIn).not.toBeChecked()
  await expect(group.getByRole('radio', { checked: true })).toHaveCount(1)
  await expect(group).toContainText('Keep this local document when switching providers.')
  await expect(memoryDocument).toHaveCount(0)
  await expect(text).toHaveCount(0)
  await expect(group.getByRole('button', { name: 'Compact', exact: true })).toBeVisible()
  await page.reload()
  await expect(external).toBeChecked()
  await expect(builtIn).not.toBeChecked()
  await page.getByRole('switch', { name: 'Saved memories', exact: true }).click()
  await expect(external).toBeChecked()
  await expect(external).toBeDisabled()
  await expect(builtIn).toBeDisabled()
  await expect(page.getByRole('button', { name: 'Manage QA Mem0 memory', exact: true })).toBeDisabled()
  await expect(group.getByRole('button', { name: 'View full memory', exact: true })).toBeDisabled()
  await page.getByRole('switch', { name: 'Saved memories', exact: true }).click()
  await expect(external).toBeChecked()
  await group.getByRole('button', { name: 'View full memory', exact: true }).click()
  await expect(memoryDocument).toContainText('Keep this local document when switching providers.')
  await expect(external).toBeChecked()
  await editFromAside(page, aside)
  await expect(text).toHaveValue(content)
  await aside.getByRole('button', { name: 'Cancel', exact: true }).click()
  await aside.getByRole('button', { name: 'Close details', exact: true }).click()
  await builtIn.click()
  await expect(builtIn).toBeChecked()
  await expect(external).not.toBeChecked()
  await expect(memoryDocument).toHaveCount(0)
  expect(errors).toEqual([])
})

test('the Memory page opens a filtered connector picker and validates bank setup', async ({ page }) => {
  const errors = collectPageErrors(page)
  await loginViaEmailCode(page)
  await page.goto('/settings/memory')
  const add = page.getByRole('button', { name: 'Add connection', exact: true })
  await expect(add).toBeDisabled()
  await page.getByRole('switch', { name: 'Saved memories', exact: true }).click()
  await expect(add).toBeEnabled()
  await expect(add).toHaveText('')
  await expect(add).toHaveAttribute('title', 'Add connection')
  const addBounds = (await add.boundingBox())!
  const headingBounds = (await page.getByRole('heading', { name: 'Memory provider', exact: true }).boundingBox())!
  expect(Math.abs(addBounds.width - addBounds.height)).toBeLessThanOrEqual(1)
  expect(Math.abs(addBounds.y + addBounds.height / 2 - headingBounds.y - headingBounds.height / 2)).toBeLessThanOrEqual(
    2,
  )
  await add.click()
  await expect(page.getByRole('heading', { name: 'New Connection', exact: true })).toBeVisible()
  const logoSources = new Set<string>()
  for (const name of ['Supermemory', 'Mem0', 'Hindsight Cloud', 'Zep']) {
    const choice = page.getByRole('button', { name: `${name} Memory`, exact: true })
    await expect(choice).toBeVisible()
    const logo = choice.locator('img')
    await expect.poll(() => logo.evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0)
    const source = (await logo.getAttribute('src'))!
    expect(source.startsWith('data:image/') || new URL(source, page.url()).origin === new URL(page.url()).origin).toBe(
      true,
    )
    logoSources.add(source)
  }
  expect(logoSources.size).toBe(4)
  await expect(page.getByRole('button', { name: 'OpenRouter', exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: 'Supermemory Memory', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Supermemory', exact: true })).toBeVisible()
  const connect = page.getByRole('button', { name: 'Connect Supermemory', exact: true })
  const continueButton = page.getByRole('button', { name: 'Continue', exact: true })
  await expect(connect).toBeEnabled()
  await expect(continueButton).toBeDisabled()
  const connectBounds = (await connect.boundingBox())!
  const footerBounds = (await continueButton.boundingBox())!
  expect(connectBounds.y + connectBounds.height).toBeLessThan(footerBounds.y)
  await expect(page.getByRole('link', { name: 'Setup instructions', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Go back', exact: true }).click()
  await page.getByRole('button', { name: 'Hindsight Cloud Memory', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Hindsight Cloud', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Continue', exact: true })).toBeDisabled()
  await expect(page.getByRole('button', { name: 'Connect Hindsight Cloud', exact: true })).toBeDisabled()
  await page.getByRole('textbox', { name: 'Memory bank ID', exact: true }).fill('../wrong/bank')
  await expect(page.getByRole('button', { name: 'Connect Hindsight Cloud', exact: true })).toBeDisabled()
  await page.getByRole('textbox', { name: 'Memory bank ID', exact: true }).fill('qa-memory-bank')
  await expect(page.getByRole('button', { name: 'Connect Hindsight Cloud', exact: true })).toBeEnabled()
  await expect(page).toHaveURL(/\/settings\/memory$/)
  expect(errors).toEqual([])
})
