/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { Locator, Page } from '@playwright/test'
import { defaultModelOpus5 } from '../shared/defaults/models'
import { widgetPrompts } from '../src/ai/eval/widget-prompts'
import { getHostname } from '../src/widgets/link-preview/utils'
import { loginViaOidc, sendChatPrompt } from './helpers'
import { expect, test } from './test'

test.slow()

const widgetIds = [
  'WIDGET_WEATHER_FORECAST',
  'WIDGET_MAP',
  'WIDGET_ASK',
  'WIDGET_LINK_PREVIEW',
  'WIDGET_CONNECT_INTEGRATION',
] as const

const linkUrl = 'https://www.typescriptlang.org/docs/handbook/intro.html'

/** Surface failed data/tiles requests separately from a model that omitted a widget. */
const expectWidget = async (page: Page, widget: Locator, id: string, failures: string[]) => {
  try {
    await expect(widget).toBeVisible({ timeout: 75_000 })
  } catch {
    const fallback = page.getByText(
      /Unable to load weather forecast|The map couldn’t be loaded|Maps can’t be displayed here/,
    )
    if (failures.length || (await fallback.count())) {
      throw new Error(`${id}: prerequisite failed: ${failures.join('; ') || (await fallback.first().textContent())}`)
    }
    throw new Error(`${id}: model did not emit the widget`)
  }
}

for (const id of widgetIds) {
  test(`${id} renders real content`, async ({ page }) => {
    const failures: string[] = []
    const prerequisite = /open-meteo\.com|openfreemap\.org|typescriptlang\.org|\/v1\/preview|\/v1\/integrations/
    page.on('requestfailed', (request) => {
      if (prerequisite.test(request.url())) failures.push(`${request.url()}: ${request.failure()?.errorText}`)
    })
    page.on('response', (response) => {
      if (response.status() >= 400 && prerequisite.test(response.url())) {
        failures.push(`${response.status()} ${response.url()}`)
      }
    })

    await loginViaOidc(page)
    await page.getByTestId('model-selector-trigger').click()
    await page.getByRole('button', { name: defaultModelOpus5.name, exact: true }).click()
    const prompt =
      id === 'WIDGET_LINK_PREVIEW'
        ? `${widgetPrompts[id]} Use ${linkUrl} directly and show its link preview; do not search.`
        : widgetPrompts[id]
    await sendChatPrompt(page, prompt)

    if (id === 'WIDGET_WEATHER_FORECAST') {
      await expectWidget(page, page.getByLabel('Temperature Unit'), id, failures)
    } else if (id === 'WIDGET_MAP') {
      const canvas = page.locator('canvas.maplibregl-canvas')
      await expectWidget(page, canvas, id, failures)
      try {
        await expect(canvas.locator('xpath=../../..').locator('[data-slot="skeleton"]')).toHaveCount(0, {
          timeout: 30_000,
        })
      } catch {
        throw new Error(`${id}: prerequisite failed: map tiles did not finish loading`)
      }
      const fallback = page.getByText(/The map couldn’t be loaded|Maps can’t be displayed here/)
      if (await fallback.count()) throw new Error(`${id}: prerequisite failed: ${await fallback.first().textContent()}`)
    } else if (id === 'WIDGET_ASK') {
      const message = page.locator('[data-quotable-message-id]').last()
      await expectWidget(page, message.getByText(/Choose one|Your call|Select all that apply/), id, failures)
      await expect.poll(() => message.getByRole('button').count()).toBeGreaterThanOrEqual(2)
    } else if (id === 'WIDGET_LINK_PREVIEW') {
      const title = page.locator(`a[href="${linkUrl}"] .line-clamp-1`)
      await expectWidget(page, title, id, failures)
      if ((await title.textContent())?.trim() === getHostname(linkUrl)) {
        throw new Error(`${id}: prerequisite failed: link preview returned its hostname fallback`)
      }
    } else {
      const message = page.locator('[data-quotable-message-id]').last()
      await expectWidget(page, message.getByText('Outlook', { exact: true }), id, failures)
      await expect(message.getByText('Google', { exact: true })).toBeVisible()
    }
  })
}
