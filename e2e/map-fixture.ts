/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { importBackup } from './import-backup'
import type { Page } from '@playwright/test'
import { defaultModelOpus55 } from '../shared/defaults/models'
import { loginViaEmailCode, openSidebarOnMobile } from './helpers'

export const mapStyleUrl = 'https://tiles.openfreemap.org/styles/positron'

/** Keep map lifecycle checks independent of public tile-server availability. */
export const installMapStyleFixture = async (page: Page) => {
  await page.route(mapStyleUrl, (route) =>
    route.fulfill({
      json: {
        version: 8,
        sources: {},
        layers: [{ id: 'background', type: 'background', paint: { 'background-color': '#f4f4f4' } }],
      },
    }),
  )
}

/** Import a disposable conversation with maps well outside its initial viewport. */
export const prepareMapHistory = async (page: Page, mapCount = 2) => {
  const email = await loginViaEmailCode(page)
  const chatId = crypto.randomUUID()
  const messagePrefix = crypto.randomUUID().slice(0, 24)
  const messageId = (index: number) => `${messagePrefix}${index.toString().padStart(12, '0')}`
  const data = JSON.stringify({
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [-122.3321, 47.6062] },
        properties: { label: 'Seattle', description: 'Map fixture office' },
      },
    ],
  })
  const fixture = {
    format: 'thunderbolt-export',
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    user: { id: 'map-fixture', email },
    tables: {
      chat_threads: [{ id: chatId, title: 'Map preview history' }],
      chat_messages: Array.from({ length: 80 }, (_, index) => {
        const hasMap = index >= 21 && index < 21 + mapCount * 4 && (index - 21) % 4 === 0
        const text = `History message ${index + 1}. ${'Keep this conversation responsive. '.repeat(12)}${
          hasMap ? `\n\n<widget:map title="Map history ${index}" data='${data}' />` : ''
        }`
        return {
          id: messageId(index),
          chatThreadId: chatId,
          parentId: index === 0 ? null : messageId(index - 1),
          role: index % 2 === 0 ? 'user' : 'assistant',
          modelId: defaultModelOpus55.id,
          content: text,
          parts: [{ type: 'text', text }],
        }
      }),
    },
  }
  await importBackup(page, fixture)
  await page.goto('/chats/new')
  await openSidebarOnMobile(page)
  await page.getByRole('button', { name: 'Map preview history', exact: true }).click()
  await page.getByText('Map history 21', { exact: true }).waitFor({ state: 'attached' })
  return { chatId }
}
