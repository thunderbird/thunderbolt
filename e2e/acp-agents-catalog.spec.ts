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

  test('connect-via-bridge opens the bridge dialog with the run command for an npx agent', async ({ page }) => {
    const errors = collectPageErrors(page)
    await loginViaOidc(page)
    await page.goto('/settings/agents')

    await expect(page.getByTestId('agent-catalog-card-gemini')).toBeVisible({ timeout: 10_000 })

    // Open the bridge dialog from the gemini card (npx distribution).
    await page.getByTestId('agent-catalog-connect-gemini').click()
    await expect(page.getByTestId('bridge-connect-dialog')).toBeVisible()

    // The composed bridge run command is shown for the user to copy.
    await expect(page.getByText('thunderbolt bridge --mode acp --', { exact: false })).toBeVisible()
    // The install one-liner is present too.
    await expect(page.getByText('curl -fsSL', { exact: false })).toBeVisible()

    // Close the dialog.
    await page.getByRole('button', { name: /done/i }).click()
    await expect(page.getByTestId('bridge-connect-dialog')).toHaveCount(0)

    expect(errors).toEqual([])
  })

  test('connect-via-bridge shows the binary fallback for a binary-only agent', async ({ page }) => {
    const errors = collectPageErrors(page)
    await loginViaOidc(page)
    await page.goto('/settings/agents')

    await expect(page.getByTestId('agent-catalog-card-goose')).toBeVisible({ timeout: 10_000 })

    // Goose ships as a platform binary — the dialog renders the fallback, no run command.
    await page.getByTestId('agent-catalog-connect-goose').click()
    await expect(page.getByTestId('bridge-connect-dialog')).toBeVisible()
    await expect(page.getByText(/ships as a platform binary/i)).toBeVisible()
    await expect(page.getByText('thunderbolt bridge --mode acp --', { exact: false })).toHaveCount(0)

    expect(errors).toEqual([])
  })
})
