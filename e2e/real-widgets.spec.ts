/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { Locator, Page, Request } from '@playwright/test'
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
// The weather widget gives up on a request after 10 s. A cancel that comes sooner is the browser dropping a request
// it no longer needs, such as map tiles while the camera moves, so only a cancel after ~10 s counts as an outage.
const cancelledError = /ERR_ABORTED|NS_BINDING_ABORTED|cancelled/i
const slowRequestMs = 9_000

type Requests = { failures: string[]; outages: string[] }

/**
 * Skip when only a third-party service failed (down or too slow): not our regression, so it must not fail the
 * Nightly. A recorded bad request still fails.
 */
const skipOnOutage = (id: string, { failures, outages }: Requests) =>
  test.skip(outages.length > 0 && failures.length === 0, `${id}: third-party outage: ${outages.join('; ')}`)

/** The backend fetches link previews itself, so the browser never sees the page fail; ask the page directly. */
const probeOutage = async (url: string): Promise<string[]> => {
  try {
    const { status } = await fetch(url, { signal: AbortSignal.timeout(10_000) })
    return status === 429 || status >= 500 ? [`${status} ${url}`] : []
  } catch (error) {
    return [`${url}: ${error instanceof Error ? error.message : String(error)}`]
  }
}

/** Surface failed data/tiles requests separately from a model that omitted a widget. */
const expectWidget = async (page: Page, widget: Locator, id: string, requests: Requests) => {
  const { failures } = requests
  try {
    await expect(widget).toBeVisible({ timeout: 75_000 })
  } catch {
    skipOnOutage(id, requests)
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
    const requests: Requests = { failures: [], outages: [] }
    const { failures, outages } = requests
    const startedAt = new Map<Request, number>()
    page.on('request', (request) => startedAt.set(request, Date.now()))
    page.on('requestfailed', (request) => {
      const errorText = request.failure()?.errorText ?? ''
      const entry = `${request.url()}: ${errorText}`
      if (thirdPartyHost.test(request.url())) {
        const pendingMs = Date.now() - (startedAt.get(request) ?? Date.now())
        if (!cancelledError.test(errorText) || pendingMs >= slowRequestMs) {
          outages.push(entry)
        }
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
      await expectWidget(page, page.getByLabel('Temperature Unit'), id, requests)
    } else if (id === 'WIDGET_MAP') {
      const canvas = page.locator('canvas.maplibregl-canvas')
      await expectWidget(page, canvas, id, requests)
      try {
        await expect(canvas.locator('xpath=../../..').locator('[data-slot="skeleton"]')).toHaveCount(0, {
          timeout: 30_000,
        })
      } catch {
        skipOnOutage(id, requests)
        throw new Error(`${id}: prerequisite failed: map tiles did not finish loading`)
      }
      const fallback = page.getByText(/The map couldn’t be loaded|Maps can’t be displayed here/)
      if (await fallback.count()) {
        skipOnOutage(id, requests)
        throw new Error(`${id}: prerequisite failed: ${await fallback.first().textContent()}`)
      }
    } else if (id === 'WIDGET_ASK') {
      const message = page.locator('[data-quotable-message-id]').last()
      await expectWidget(page, message.getByText(/Choose one|Your call|Select all that apply/), id, requests)
      await expect.poll(() => message.getByRole('button').count()).toBeGreaterThanOrEqual(2)
    } else if (id === 'WIDGET_LINK_PREVIEW') {
      const title = page.locator(`a[href="${linkUrl}"] .line-clamp-1`)
      await expectWidget(page, title, id, requests)
      if ((await title.textContent())?.trim() === getHostname(linkUrl)) {
        skipOnOutage(id, { failures, outages: await probeOutage(linkUrl) })
        throw new Error(`${id}: prerequisite failed: link preview returned its hostname fallback`)
      }
    } else {
      const message = page.locator('[data-quotable-message-id]').last()
      await expectWidget(page, message.getByRole('button', { name: 'Connect Microsoft' }), id, requests)
      await expect(
        message.getByRole('heading', { name: 'Thunderbolt wants to connect to Microsoft Calendar' }),
      ).toBeVisible()
    }
  })
}
