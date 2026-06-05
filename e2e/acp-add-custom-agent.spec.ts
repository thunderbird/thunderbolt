/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { test, expect } from '@playwright/test'
import { collectPageErrors, loginViaOidc } from './helpers'

/**
 * E2E for the "Add Custom Agent" CRUD path on `/settings/agents`.
 *
 * We open the dialog, submit a syntactically-valid (but unreachable) WebSocket
 * URL, and assert that the new row materialises in the agent list. The
 * connection attempt would obviously fail at runtime — that's not what this
 * test cares about. The contract under test is: dialog → DAL insert → PowerSync
 * live query → UI row. A regression in any of those layers would either keep
 * the dialog open, surface an exception, or leave the list empty.
 */
test.describe('ACP add custom agent', () => {
  test('submitting the dialog persists a new row to the list', async ({ page }) => {
    const errors = collectPageErrors(page)

    await loginViaOidc(page)

    await page.goto('/settings/agents')
    await expect(page.getByTestId('agent-list')).toBeVisible({ timeout: 10_000 })

    await page.getByRole('button', { name: 'Add Custom Agent' }).click()

    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()

    // The dialog mounts behind a Radix open animation on a cold, first-hit
    // transpiled chunk. A single synthetic `input` from `.fill()` can land before
    // React has wired the controlled-input onChange, leaving `name`/`url` state
    // empty while the DOM shows the text — which keeps the submit button
    // `disabled={!canSubmit}` and hangs the click for the whole timeout.
    // `pressSequentially` fires per-character events React commits reliably; scope
    // the fields to the open dialog.
    await dialog.getByLabel('Name').pressSequentially('Test Agent')
    await dialog.getByLabel('URL').pressSequentially('wss://invalid.example.test/ws')
    await dialog.getByLabel('Description').pressSequentially('Test description')

    // Assert the enable-gate before clicking: a regression now fails fast and
    // legibly instead of hanging 60s on a disabled button.
    const submit = page.getByRole('button', { name: 'Add Agent' })
    await expect(submit).toBeEnabled()
    await submit.click()

    // Dialog dismisses on success — if validation rejected the URL the dialog
    // would stay open with an inline error.
    await expect(dialog).toBeHidden({ timeout: 5_000 })

    // The new row is rendered by name. PowerSync's live query feeds the list
    // from the synced `agents` table so the row should appear without a manual
    // reload.
    await expect(page.getByText('Test Agent')).toBeVisible({ timeout: 10_000 })
    await expect(page.getByText('Test description')).toBeVisible()

    expect(errors).toHaveLength(0)
  })
})
