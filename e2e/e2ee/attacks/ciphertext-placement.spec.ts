/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * A3 — ciphertext substitution and rollback (C3). **Relocation is prevented;
 * same-cell rollback is not (a residual the claim itself flags).**
 *
 * C3's AAD is `table ‖ column ‖ row_id ‖ key_id`. Test 1 relocates ciphertext
 * across rows: the AAD `row_id` no longer matches, GCM auth fails, and
 * `codec.decode` returns the RAW wire value (src/db/encryption/codec.ts) rather
 * than plaintext or a crash — the user sees `__enc:` gibberish, never the moved
 * secret. Relocation is a recoverable DoS (C7), not a confidentiality break.
 *
 * Test 2 is the boundary C3 names in its own parenthetical — "the AAD carries no
 * version or timestamp". A malicious server that keeps an older ciphertext of
 * the SAME cell can replay it: same row_id, column, and key_id, so the AAD
 * matches by construction and decrypt succeeds. The client silently renders the
 * stale value. This resurrects the user's own prior plaintext (an integrity /
 * freshness loss), not attacker-chosen plaintext — but nothing detects it. It is
 * a documented residual, pinned here as an executable witness; escalation is a
 * Phase 5 decision.
 *
 * Requires the PowerSync + Postgres harness. Run with:
 *   bash scripts/run-e2ee-powersync.sh attacks/ciphertext-placement.spec.ts
 */

import { expect, test } from '../fixtures'
import { getTaskCiphertext, getTaskIds, swapCells, waitForUserId, writeCell } from '../db'
import {
  completeFirstDeviceSetup,
  createE2eeEmail,
  createTask,
  editTask,
  enableTasks,
  loginViaConsumerOtp,
} from '../helpers'
import { defaultTasks } from '../../../src/defaults/tasks'

const rawCiphertext = /^__enc:v2:0:/

// Enabling tasks reconciles three default tasks (fixed ids) onto the account.
// Filter them out so a test sees only the rows it created, regardless of how far
// default seeding has progressed.
const defaultTaskIds = new Set(defaultTasks.map((task) => task.id))

/** Poll until exactly `count` non-default task rows exist; returns their ids. */
const waitForCreatedTaskIds = async (userId: string, count: number): Promise<string[]> => {
  let created: string[] = []
  await expect
    .poll(
      async () => {
        created = [...(await getTaskIds(userId))].filter((id) => !defaultTaskIds.has(id))
        return created.length
      },
      { timeout: 30_000 },
    )
    .toBe(count)
  return created
}

test.describe.serial('A3 — ciphertext substitution and rollback', () => {
  test('a cross-row ciphertext swap fails GCM and never renders the moved plaintext', async ({ page }) => {
    const email = createE2eeEmail()
    const alpha = `alpha-${crypto.randomUUID()}`
    const bravo = `bravo-${crypto.randomUUID()}`

    await loginViaConsumerOtp(page, email)
    const userId = await waitForUserId(email)
    await completeFirstDeviceSetup(page)
    await enableTasks(page)

    // Persist each task to the server before creating the next: the second
    // createTask navigates to /tasks, which would drop the first task's write if
    // it had not yet flushed to PowerSync.
    await createTask(page, alpha)
    await waitForCreatedTaskIds(userId, 1)
    await createTask(page, bravo)

    // Both rows synced to the server. Grab their ids (which one is which does not
    // matter — after the swap both fail the row_id AAD check).
    const rowIds = await waitForCreatedTaskIds(userId, 2)

    // The malicious server relocates ciphertext across cells.
    await swapCells(
      { table: 'tasks', rowId: rowIds[0], column: 'item' },
      { table: 'tasks', rowId: rowIds[1], column: 'item' },
    )

    // The reactive query re-decodes as the swap syncs down: both cells fail GCM
    // and fall back to the raw wire value. The moved plaintext is never shown.
    await expect(page.getByText(rawCiphertext).first()).toBeVisible({ timeout: 30_000 })
    await expect(page.getByText(alpha, { exact: true })).toHaveCount(0)
    await expect(page.getByText(bravo, { exact: true })).toHaveCount(0)
  })

  test('a same-cell rollback to an older ciphertext is AAD-valid and renders stale plaintext', async ({ page }) => {
    const email = createE2eeEmail()
    const original = `rollback-v1-${crypto.randomUUID()}`
    const updated = `rollback-v2-${crypto.randomUUID()}`

    await loginViaConsumerOtp(page, email)
    const userId = await waitForUserId(email)
    await completeFirstDeviceSetup(page)
    await enableTasks(page)

    await createTask(page, original)
    const [rowId] = await waitForCreatedTaskIds(userId, 1)
    const staleCiphertext = await getTaskCiphertext(rowId)

    // Edit the task, and wait until the new ciphertext has synced UP — so the
    // client has no pending write left to re-assert over the rollback.
    await editTask(page, original, updated)
    await expect.poll(async () => getTaskCiphertext(rowId), { timeout: 30_000 }).not.toBe(staleCiphertext)
    await expect(page.getByText(updated, { exact: true })).toBeVisible()

    // The malicious server replays the OLD ciphertext into the same cell. Same
    // row_id / column / key_id, so the AAD matches and decrypt succeeds.
    await writeCell({ table: 'tasks', rowId, column: 'item' }, staleCiphertext)

    // The stale value resurfaces, undetected — the AAD cannot express freshness.
    await expect(page.getByText(original, { exact: true })).toBeVisible({ timeout: 30_000 })
  })
})
