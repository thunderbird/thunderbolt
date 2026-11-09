/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Sharing a chat with a specific person, end to end on the real stack: Alice
 * shares a chat by email, Bob opens it read-only from Shared, the server holds
 * only ciphertext, sharing again updates the same share in place, stopping the
 * share takes it away, and a recipient can remove one shared with them (claim
 * C16).
 *
 * A chat needs a model reply, so this spec starts the fake Anthropic provider
 * the E2EE backend is pointed at (`ANTHROPIC_BASE_URL` in playwright.e2ee.config.ts).
 *
 * Requires the PowerSync + Postgres harness. Run with:
 *   bash scripts/run-e2ee-powersync.sh share.spec.ts
 */

import type { Page } from '@playwright/test'
import type { Server } from 'node:http'
import { defaultModelOpus55 } from '../../shared/defaults/models'
import { createFakeProvider, fakeProviderReply } from '../fake-provider'
import { getChatShares, getReceivedShareTitles, waitForSyncedChatThread, waitForUserId } from './db'
import { expect, test } from './fixtures'
import { completeFirstDeviceSetup, createE2eeEmail, createIsolatedDevice, loginViaConsumerOtp } from './helpers'

/** Must match `e2eeFakeProviderPort` in playwright.e2ee.config.ts. */
const fakeProviderPort = Number(process.env.E2EE_FAKE_PROVIDER_PORT ?? 9879)

const sendFirstMessage = async (page: Page, text: string): Promise<void> => {
  await page.goto('/chats/new')
  await page.getByTestId('model-selector-trigger').click()
  await page.getByRole('button', { name: defaultModelOpus55.name, exact: true }).click()
  await page.keyboard.press('Escape')
  await page.locator('textarea').fill(text)
  await page.getByRole('button', { name: 'Send message' }).click()
  await expect(page.getByText(fakeProviderReply)).toBeVisible({ timeout: 30_000 })
}

const sendFollowUp = async (page: Page, text: string): Promise<void> => {
  await page.locator('textarea').fill(text)
  await page.getByRole('button', { name: 'Send message' }).click()
  await expect(page.getByText(text)).toBeVisible()
  await expect(page.getByText(fakeProviderReply)).toHaveCount(2, { timeout: 30_000 })
}

const addRecipient = async (page: Page, email: string): Promise<void> => {
  const input = page.getByRole('textbox', { name: 'Email addresses' })
  await input.fill(email)
  await input.press('Enter')
}

test.describe.serial('Sharing a chat', () => {
  let provider: Server

  test.beforeAll(async () => {
    provider = await createFakeProvider(fakeProviderPort)
  })

  test.afterAll(async () => {
    await new Promise((resolve) => provider.close(resolve))
  })

  test('a chat shared by email is readable by its recipient and nobody else, until it is unshared', async ({
    browser,
    page,
  }) => {
    const aliceEmail = createE2eeEmail()
    const bobEmail = createE2eeEmail()
    const prompt = `Share check ${crypto.randomUUID()}`

    // Bob first: a recipient must already have sync set up to be shareable with.
    const bob = await createIsolatedDevice(browser, 'safari')
    await loginViaConsumerOtp(bob.page, bobEmail)
    const bobUserId = await waitForUserId(bobEmail)
    await completeFirstDeviceSetup(bob.page)

    await loginViaConsumerOtp(page, aliceEmail)
    const aliceUserId = await waitForUserId(aliceEmail)
    await completeFirstDeviceSetup(page)
    await sendFirstMessage(page, prompt)
    const chatThreadId = await waitForSyncedChatThread(aliceUserId)
    await page.goto(`/chats/${chatThreadId}`)

    await page.getByRole('button', { name: 'Share chat' }).click()
    const dialog = page.getByRole('dialog')
    // The form mounts once the dialog has loaded and checked the chat's current share.
    await expect(dialog.getByRole('textbox', { name: 'Email addresses' })).toBeVisible({ timeout: 30_000 })

    // An address with no account is refused in the input, like one without sync.
    await addRecipient(page, createE2eeEmail())
    await expect(dialog.getByText('can’t receive shared chats', { exact: false })).toBeVisible()
    await dialog.getByRole('button', { name: /^Remove / }).click()

    await addRecipient(page, bobEmail)
    await expect(dialog.getByTestId('share-recipient-tag')).toHaveAttribute('data-status', 'ok')
    await dialog.getByRole('button', { name: 'Share', exact: true }).click()
    await expect(dialog.getByText('Shared with 1 person.', { exact: false })).toBeVisible({ timeout: 30_000 })
    await dialog.getByRole('button', { name: 'Done' }).click()

    // The server holds ciphertext only: neither side of the chat appears in it.
    const [share] = await getChatShares(aliceUserId)
    expect(share.recipientCount).toBe(1)
    const stored = Buffer.from(share.encryptedSnapshot, 'base64').toString('latin1')
    expect(stored).not.toContain(prompt)
    expect(stored).not.toContain(fakeProviderReply)
    // The title, made from the prompt, syncs to Bob's list as that same ciphertext.
    expect(Buffer.from(share.encryptedTitle, 'base64').toString('latin1')).not.toContain(prompt)
    await expect
      .poll(async () => (await getReceivedShareTitles(bobUserId)).get(share.id), { timeout: 30_000 })
      .toBe(share.encryptedTitle)

    // Bob reads it from Shared, view-only, with no composer.
    await bob.page.goto('/shared')
    const sharedRow = bob.page.getByRole('button', { name: /^Open / })
    await expect(sharedRow).toBeVisible({ timeout: 30_000 })
    await sharedRow.click()
    await expect(bob.page).toHaveURL(new RegExp(`/shared/${share.id}$`))
    await expect(bob.page.getByText(prompt)).toBeVisible({ timeout: 30_000 })
    await expect(bob.page.getByText(fakeProviderReply)).toBeVisible()
    await expect(bob.page.getByText('View only')).toBeVisible()
    await expect(bob.page.locator('textarea')).toHaveCount(0)

    // Someone it was not shared with gets nothing for the same link.
    const mallory = await createIsolatedDevice(browser, 'windows')
    await loginViaConsumerOtp(mallory.page, createE2eeEmail())
    await completeFirstDeviceSetup(mallory.page)
    await mallory.page.goto(`/shared/${share.id}`)
    await expect(mallory.page.getByText('This chat is no longer shared with you')).toBeVisible({ timeout: 30_000 })

    // Sharing again opens on the existing share and refreshes it in place: same
    // id, same person, the newer chat.
    const followUp = `Follow-up ${crypto.randomUUID()}`
    await sendFollowUp(page, followUp)
    await page.getByRole('button', { name: 'Share chat' }).click()
    await expect(dialog.getByText('Shared with 1 person. Saving updates everyone', { exact: false })).toBeVisible()
    await expect(dialog.getByTestId('share-recipient-tag')).toHaveAttribute('data-status', 'ok')
    await dialog.getByRole('button', { name: 'Update to latest' }).click()
    await expect(dialog.getByText('Share updated')).toBeVisible({ timeout: 30_000 })
    await dialog.getByRole('button', { name: 'Done' }).click()

    const updated = await getChatShares(aliceUserId)
    expect(updated.map(({ id, recipientCount }) => ({ id, recipientCount }))).toEqual([
      { id: share.id, recipientCount: 1 },
    ])
    expect(Buffer.from(updated[0].encryptedSnapshot, 'base64').toString('latin1')).not.toContain(followUp)
    await bob.page.reload()
    await expect(bob.page.getByText(followUp)).toBeVisible({ timeout: 30_000 })

    // Alice stops sharing. Both lists drop it as the stop syncs, with no reload.
    await bob.page.goto('/shared')
    await expect(bob.page.getByRole('button', { name: /^Open / })).toBeVisible({ timeout: 30_000 })
    await page.goto('/shared?tab=sent')
    await page.getByRole('button', { name: /^Open / }).click()
    // The detail panel's ⋯ menu; sidebar chat rows carry "More" buttons of their own.
    const detailPanel = page.locator('section').filter({ has: page.getByRole('button', { name: 'Close details' }) })
    await detailPanel.getByRole('button', { name: 'More' }).click()
    await page.getByRole('menuitem', { name: 'Stop sharing' }).click()
    await page.getByRole('alertdialog').getByRole('button', { name: 'Stop sharing', exact: true }).click()
    await expect(page.getByText('You haven’t shared any chats')).toBeVisible({ timeout: 30_000 })
    await expect(bob.page.getByText('Nothing shared with you yet')).toBeVisible({ timeout: 30_000 })
    expect(await getChatShares(aliceUserId)).toEqual([])
    await bob.page.goto(`/shared/${share.id}`)
    await expect(bob.page.getByText('This chat is no longer shared with you')).toBeVisible({ timeout: 30_000 })

    // Shared again from scratch, Bob removes it himself: it leaves his Shared
    // list, and with nobody left on it the share is gone from the server.
    await page.goto(`/chats/${chatThreadId}`)
    await page.getByRole('button', { name: 'Share chat' }).click()
    await addRecipient(page, bobEmail)
    await expect(dialog.getByTestId('share-recipient-tag')).toHaveAttribute('data-status', 'ok')
    await dialog.getByRole('button', { name: 'Share', exact: true }).click()
    await expect(dialog.getByText('Chat shared')).toBeVisible({ timeout: 30_000 })
    await dialog.getByRole('button', { name: 'Done' }).click()
    const [reshared] = await getChatShares(aliceUserId)

    await bob.page.goto(`/shared/${reshared.id}`)
    await expect(bob.page.getByText(followUp)).toBeVisible({ timeout: 30_000 })
    await bob.page.getByRole('button', { name: 'Remove', exact: true }).click()
    await bob.page.getByRole('alertdialog').getByRole('button', { name: 'Remove', exact: true }).click()
    await expect(bob.page).toHaveURL(/\/shared$/)
    await expect(bob.page.getByText('Nothing shared with you yet')).toBeVisible({ timeout: 30_000 })
    await expect.poll(async () => (await getChatShares(aliceUserId)).length, { timeout: 30_000 }).toBe(0)

    await bob.context.close()
    await mallory.context.close()
  })
})
