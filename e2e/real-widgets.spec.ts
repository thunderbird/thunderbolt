/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { Locator, Page } from '@playwright/test'
import { defaultModelOpus55 } from '../shared/defaults/models'
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

const thirdPartyHost = /open-meteo\.com|openfreemap\.org|typescriptlang\.org/
const ownRoute = /\/v1\/preview|\/v1\/integrations/

/** Skip when a third-party service was down or too slow: not our regression, so it must not fail the Nightly. */
const skipOnOutage = (id: string, outages: string[]) =>
  test.skip(outages.length > 0, `${id}: third-party outage: ${outages.join('; ')}`)

/** Surface failed data/tiles requests separately from a model that omitted a widget. */
const expectWidget = async (page: Page, widget: Locator, id: string, failures: string[], outages: string[]) => {
  try {
    await expect(widget).toBeVisible({ timeout: 75_000 })
  } catch {
    skipOnOutage(id, outages)
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
    // A 4xx from a third party means we sent a bad request, so only network errors, 429 and 5xx count as outages.
    const failures: string[] = []
    const outages: string[] = []
    page.on('requestfailed', (request) => {
      const entry = `${request.url()}: ${request.failure()?.errorText}`
      if (thirdPartyHost.test(request.url())) {
        outages.push(entry)
      } else if (ownRoute.test(request.url())) {
        failures.push(entry)
      }
    })
    page.on('response', (response) => {
      const status = response.status()
      const entry = `${status} ${response.url()}`
      if (thirdPartyHost.test(response.url()) && (status === 429 || status >= 500)) {
        outages.push(entry)
      } else if (status >= 400 && (thirdPartyHost.test(response.url()) || ownRoute.test(response.url()))) {
        failures.push(entry)
      }
    })

    await loginViaOidc(page)
    await page.getByTestId('model-selector-trigger').click()
    await page.getByRole('button', { name: `${defaultModelOpus55.name} Thunderbolt`, exact: true }).click()
    await page.keyboard.press('Escape')
    const prompt =
      id === 'WIDGET_LINK_PREVIEW'
        ? `Show a link preview for ${linkUrl}. Use only this URL; do not search or suggest other links.`
        : widgetPrompts[id]
    await sendChatPrompt(page, prompt)

    if (id === 'WIDGET_WEATHER_FORECAST') {
      await expectWidget(page, page.getByLabel('Temperature Unit'), id, failures, outages)
    } else if (id === 'WIDGET_MAP') {
      const canvas = page.locator('canvas.maplibregl-canvas')
      await expectWidget(page, canvas, id, failures, outages)
      try {
        await expect(canvas.locator('xpath=../../..').locator('[data-slot="skeleton"]')).toHaveCount(0, {
          timeout: 30_000,
        })
      } catch {
        skipOnOutage(id, outages)
        throw new Error(`${id}: prerequisite failed: map tiles did not finish loading`)
      }
      const fallback = page.getByText(/The map couldn’t be loaded|Maps can’t be displayed here/)
      if (await fallback.count()) {
        skipOnOutage(id, outages)
        throw new Error(`${id}: prerequisite failed: ${await fallback.first().textContent()}`)
      }
    } else if (id === 'WIDGET_ASK') {
      const message = page.locator('[data-quotable-message-id]').last()
      await expectWidget(page, message.getByText(/Choose one|Your call|Select all that apply/), id, failures, outages)
      await expect.poll(() => message.getByRole('button').count()).toBeGreaterThanOrEqual(2)
    } else if (id === 'WIDGET_LINK_PREVIEW') {
      const title = page.locator(`a[href="${linkUrl}"] .line-clamp-1`)
      await expectWidget(page, title, id, failures, outages)
      if ((await title.textContent())?.trim() === getHostname(linkUrl)) {
        throw new Error(`${id}: prerequisite failed: link preview returned its hostname fallback`)
      }
    } else {
      const message = page.locator('[data-quotable-message-id]').last()
      await expectWidget(page, message.getByRole('button', { name: 'Connect Microsoft' }), id, failures, outages)
      await expect(
        message.getByRole('heading', { name: 'Thunderbolt wants to connect to Microsoft Calendar' }),
      ).toBeVisible()
    }
  })
}
