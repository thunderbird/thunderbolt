/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The deterministic layout sweep on the web: each case of scripts/sweep.ts reaches one key screen in one hard state,
// then checks it two ways. The layout probe's geometry must report nothing, and the screen's crop must match the
// baseline a person approved. A case without a baseline only writes its crop as a candidate under
// `<out>/sweep/candidates/`, so the sweep passes cleanly until someone approves one (README, "Layout sweep").
// Trusted harness code: it runs in its own job with no secret, never through the repro specs' lint, which bans
// snapshot assertions in the specs a model writes.
import { existsSync, readFileSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'
import { expect, test, type Locator, type Page } from '@playwright/test'
import { openSidebarOnMobile } from '../../../e2e/helpers'
import { layoutProblems } from '../layout'
import { caseName, sweepCases, sweepViewports, type SweepCase } from '../scripts/sweep'

const repo = resolve(import.meta.dirname, '../../..')
const probePath = resolve(import.meta.dirname, '../layout-probe.js')
const samplePdf = resolve(import.meta.dirname, '../fixtures/sample.pdf')

const localeTags = { en: 'en-US', de: 'de-DE', ja: 'ja-JP' } as const

/**
 * The catalog's text for an English message id, so the sweep finds a control by the name the locale shows. A message
 * the catalog leaves untranslated keeps its English id, as the app does.
 */
const translate = (locale: SweepCase['locale'], id: string) => {
  if (locale === 'en') return id
  const catalog = readFileSync(resolve(repo, `src/locales/${locale}/messages.po`), 'utf8')
  const match = new RegExp(`^msgid "${RegExp.escape(id)}"\\nmsgstr "(.+)"$`, 'm').exec(catalog)
  return match?.[1] ?? id
}

// A long unbroken word and a long link are what overflow first; the German one is real.
const longDraft = [
  'Kannst du die Donaudampfschifffahrtsgesellschaftskapitänsmützenabzeichen zusammenfassen?',
  'https://example.com/a/very/long/path/that/never/breaks/because/it/has/no/spaces/at/all/anywhere',
  'Third line of a draft that wraps on every phone.',
].join('\n')

const richReply = `## Trip budget

| Day | City | Hotel | Transport | Food | Total |
| --- | --- | --- | --- | --- | --- |
| 1 | Lisbon | Hotel Avenida Palace | Airport shuttle | 45 € | 230 € |
| 2 | Porto | Pestana Vintage Porto Hotel & World Heritage Site | Train Alfa Pendular | 52 € | 268 € |

1. Book the **Alfa Pendular** early.
2. Pack for rain: \`umbrella\`, \`rain jacket\`.

\`\`\`ts
const totalBudget = days.map((day) => day.hotel + day.transport + day.food).reduce((sum, value) => sum + value, 0)
\`\`\`

See https://example.com/lisbon-to-porto/train-timetable/2026/winter/alfa-pendular/first-class for the timetable.
`

/** The fake provider's Messages stream, in one body, carrying `text` as the whole reply. */
const messagesStream = (text: string) =>
  [
    {
      type: 'message_start',
      message: {
        id: 'msg_sweep',
        type: 'message',
        role: 'assistant',
        model: 'claude-opus-5-5',
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 0 },
      },
    },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 80 } },
    { type: 'message_stop' },
  ]
    .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
    .join('')

const chatRequest = '**/v1/chat/v1/messages'

/** Replies through the browser, so the reply is the same on every run, whatever the fake provider streams. */
const replyWith = (page: Page, text: string) =>
  page.route(chatRequest, (route) =>
    route.fulfill({ status: 200, contentType: 'text/event-stream', body: messagesStream(text) }),
  )

/** The Anthropic model, whose requests the route above answers; the default model goes elsewhere. */
const pickClaude = async (page: Page) => {
  await page.getByTestId('model-selector-trigger').click()
  await page.getByRole('button', { name: 'Opus 5.5', exact: true }).click()
}

const send = async (page: Page, locale: SweepCase['locale'], text: string) => {
  await page.locator('textarea').fill(text)
  await page.getByRole('button', { name: translate(locale, 'Send message'), exact: true }).click()
}

/** `frame` runs after the probe has measured the screen as it came, and only moves it for the crop. */
type Shot = { target: Locator; mask?: Locator[]; frame?: () => Promise<void> }

/** Each screen reaches its state from a signed-in chat and returns the crop to compare. */
const screens = {
  composer: async (page) => {
    await page.locator('textarea').fill(longDraft)
    return { target: page.locator('form:has(textarea)') }
  },
  sidebar: async (page) => {
    await openSidebarOnMobile(page)
    // The mobile drawer, or the desktop's docked sidebar.
    const sidebar = page.locator('[data-slot="sidebar"]:visible, [data-sidebar="sidebar"]:visible').first()
    return { target: sidebar, mask: [page.getByText(/@thunderbolt\.test/)] }
  },
  'model-picker': async (page) => {
    await page.getByTestId('model-selector-trigger').click()
    const picker = page.getByRole('dialog').last()
    await expect(picker).toBeVisible()
    return { target: picker }
  },
  dialog: async (page, locale) => {
    await page.goto('/settings/preferences')
    await page.getByRole('button', { name: translate(locale, 'Delete My Account'), exact: true }).click()
    const dialog = page.getByRole('alertdialog').or(page.getByRole('dialog')).last()
    await expect(dialog).toBeVisible()
    return { target: dialog }
  },
  settings: async (page) => {
    await page.goto('/settings/preferences')
    await expect(page.getByRole('switch').first()).toBeVisible()
    return { target: page.locator('main') }
  },
  'attachment-viewer': async (page, locale) => {
    await pickClaude(page)
    await replyWith(page, 'Got the file.')
    await page.locator('input[type=file]').first().setInputFiles(samplePdf)
    await send(page, locale, 'Summarize this file.')
    await page.locator('button', { hasText: 'sample.pdf' }).last().click()
    const viewer = page.locator('[data-slot="resizable-panel"]').last()
    await expect(viewer.locator('canvas, iframe, embed, object').first()).toBeVisible({ timeout: 15_000 })
    return { target: viewer }
  },
  'rich-reply': async (page, locale) => {
    await pickClaude(page)
    await replyWith(page, richReply)
    await send(page, locale, 'Plan a two-day budget.')
    // The table is what overflows first: its box, with the wrapper that scrolls it. The chat's own scroll after a
    // reply lands anywhere, so once the reply is done the table is scrolled to the same place on every run.
    await expect(page.getByRole('button', { name: translate(locale, 'Copy message'), exact: true })).toBeVisible({
      timeout: 15_000,
    })
    const table = page.getByRole('table').locator('xpath=..')
    return {
      target: table,
      frame: () => table.evaluate((wrapper) => wrapper.scrollIntoView({ block: 'center', behavior: 'instant' })),
    }
  },
  loading: async (page, locale) => {
    await pickClaude(page)
    // Never answered: the reply stays in flight while the probe and the screenshot look at it.
    await page.route(chatRequest, () => {})
    await send(page, locale, 'Plan a two-day budget.')
    await expect(page.getByRole('button', { name: translate(locale, 'Stop generating'), exact: true })).toBeVisible()
    // The composer in its in-flight state; the chat above it scrolls to a different place on each run.
    return { target: page.locator('form:has(textarea)') }
  },
} satisfies Record<SweepCase['screen'], (page: Page, locale: SweepCase['locale']) => Promise<Shot>>

/** Signs in with selectors no locale changes, as `loginViaEmailCode` does in English. */
const signIn = async (page: Page) => {
  await page.goto('/')
  await page.locator('input[type=email]').fill(`sweep-${crypto.randomUUID()}@thunderbolt.test`)
  await page.locator('button[type=submit]').click()
  await page.locator('input[autocomplete="one-time-code"]').fill('12345678')
  await expect(page.locator('textarea')).toBeVisible({ timeout: 30_000 })
}

for (const sweepCase of sweepCases) {
  const name = caseName(sweepCase)
  const { width } = sweepViewports[sweepCase.viewport]

  test.describe(name, () => {
    test.use({
      viewport: sweepViewports[sweepCase.viewport],
      isMobile: width < 768,
      hasTouch: width < 768,
      locale: localeTags[sweepCase.locale],
      // A fixed clock and zone: the chat's greeting follows the hour.
      timezoneId: 'UTC',
    })

    test('sweep', async ({ page }) => {
      await page.clock.setFixedTime(new Date('2026-03-02T10:00:00Z'))
      await page.addInitScript({ path: probePath })
      if (sweepCase.text === 'large') {
        // What Chrome's font size setting changes: the default font size, which the app's rem sizes follow.
        const cdp = await page.context().newCDPSession(page)
        await cdp.send('Page.setFontSizes', { fontSizes: { standard: 24, fixed: 20 } })
      }
      await signIn(page)
      const { target, mask, frame }: Shot = await screens[sweepCase.screen](page, sweepCase.locale)
      await expect(target).toBeVisible()

      // Polled: the chat can still be scrolling after a reply, and a problem that lasts is what counts.
      await expect
        .configure({ soft: true })
        .poll(() => layoutProblems(page), { message: 'the layout probe reports no problem', timeout: 10_000 })
        .toEqual([])
      await frame?.()

      const baseline = test.info().snapshotPath(`${name}.png`, { kind: 'screenshot' })
      if (existsSync(baseline)) {
        await expect.soft(target, 'the crop matches its approved baseline').toHaveScreenshot(`${name}.png`, {
          mask,
          maxDiffPixelRatio: 0.01,
        })
        return
      }
      // Named as its baseline would be (`<case>-linux.png` on CI), so approving it is a copy.
      const candidate = resolve(test.info().project.outputDir, 'candidates', basename(baseline))
      await mkdir(dirname(candidate), { recursive: true })
      await target.screenshot({ path: candidate, mask, animations: 'disabled', caret: 'hide' })
      test.info().annotations.push({ type: 'no baseline', description: candidate })
    })
  })
}
