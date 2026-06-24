/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { test, expect } from '@playwright/test'
import { collectPageErrors, loginViaOidc } from './helpers'

test.describe('Agents catalog', () => {
  test('browse, link out, search, and empty state work without page errors', async ({ page }) => {
    const errors = collectPageErrors(page)
    await loginViaOidc(page)

    await page.goto('/settings/agents')

    // The bundled ACP registry snapshot renders immediately — no live network needed.
    // Assert a few known registry cards by id.
    const geminiCard = page.getByTestId('agent-catalog-card-gemini')
    await expect(geminiCard).toBeVisible({ timeout: 10_000 })
    await expect(page.getByTestId('agent-catalog-card-claude-acp')).toBeVisible()
    await expect(page.getByTestId('agent-catalog-card-goose')).toBeVisible()

    // At least one link-out is present on a card.
    await expect(geminiCard.getByRole('link').first()).toBeVisible()

    // Search filters the grid: 'gemini' keeps the gemini card, drops claude-acp.
    const search = page.getByPlaceholder('Search agents')
    await search.fill('gemini')
    await expect(page.getByTestId('agent-catalog-card-gemini')).toBeVisible()
    await expect(page.getByTestId('agent-catalog-card-claude-acp')).toHaveCount(0)

    // The clear (X) button resets the query and restores the filtered-out card.
    await page.getByRole('button', { name: /clear search/i }).click()
    await expect(search).toHaveValue('')
    await expect(page.getByTestId('agent-catalog-card-claude-acp')).toBeVisible()

    // A guaranteed-no-match query shows the empty state.
    await search.fill('zzzqqqxx')
    await expect(page.getByText(/no agents found/i)).toBeVisible()

    // The background CDN fetch must not surface page errors even if it fails —
    // the snapshot fallback covers it.
    expect(errors).toEqual([])
  })
})
