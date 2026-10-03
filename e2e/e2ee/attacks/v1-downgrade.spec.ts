/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * A4 — v1 downgrade (C4). **Claim holds.**
 *
 * C4: a v2 client never writes the no-AAD v1 format and cannot be steered back
 * into it. Two structural guards, witnessed here end to end:
 *
 *   1. The encoder has no v1 writer. `codec.encode` always emits
 *      `formatWireValue` = `__enc:v2:<key_id>:…` with AAD built from the
 *      resolved key_id (src/db/encryption/codec.ts) — there is no code path that
 *      produces the legacy `__enc:<iv>:<ct>` (no-AAD) shape.
 *   2. A set-up device ignores a hostile `scheme_version`. `ensureV2Encryption`
 *      returns `already-v2` when a local AK exists, BEFORE the
 *      `scheme_version === 1` branch, so a server that flips its reported
 *      scheme back to 1 cannot re-trigger migration on a provisioned device.
 *
 * This spec flips `scheme_version` to 1 on the metadata response of a fully
 * set-up v2 device, reloads, and shows the prior data still decrypts, a new
 * write is still `__enc:v2:…`, and the server was never actually downgraded.
 *
 * Requires the PowerSync + Postgres harness. Run with:
 *   bash scripts/run-e2ee-powersync.sh attacks/v1-downgrade.spec.ts
 */

import { expect, test } from '../fixtures'
import { getSchemeVersion, getTaskCiphertext, getTaskIds, waitForUserId } from '../db'
import {
  completeFirstDeviceSetup,
  createE2eeEmail,
  createTask,
  enableTasks,
  forceSchemeVersion,
  loginViaConsumerOtp,
} from '../helpers'
import { defaultTasks } from '../../../src/defaults/tasks'

const v2Ciphertext = /^__enc:v2:0:/
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

test.describe.serial('A4 — v1 downgrade resistance', () => {
  test('a hostile scheme_version:1 cannot steer a set-up v2 client into writing v1', async ({ page }) => {
    const email = createE2eeEmail()
    const beforeFlip = `v2-before-${crypto.randomUUID()}`
    const afterFlip = `v2-after-${crypto.randomUUID()}`

    await loginViaConsumerOtp(page, email)
    const userId = await waitForUserId(email)
    await completeFirstDeviceSetup(page)
    await enableTasks(page)

    // Baseline: a set-up v2 device writes v2+AAD, and the account is scheme 2.
    await createTask(page, beforeFlip)
    const [row1] = await waitForCreatedTaskIds(userId, 1)
    expect(await getTaskCiphertext(row1)).toMatch(v2Ciphertext)
    expect(await getSchemeVersion(userId)).toBe(2)

    // The malicious server flips its reported scheme back to 1 and the device
    // re-initializes (reload re-runs ensureV2Encryption).
    await forceSchemeVersion(page.context(), 1)
    await page.reload()

    // The prior v2 data still decrypts — no re-migration wiped or re-encoded it.
    await page.goto('/tasks')
    await expect(page.getByText(beforeFlip, { exact: true })).toBeVisible({ timeout: 30_000 })

    // A new write is still v2+AAD, never the no-AAD v1 shape.
    await createTask(page, afterFlip)
    const rows = await waitForCreatedTaskIds(userId, 2)
    const row2 = rows.find((id) => id !== row1)
    expect(row2).toBeDefined()
    expect(await getTaskCiphertext(row2!)).toMatch(v2Ciphertext)

    // And the server was never actually downgraded — the lie changed no state.
    expect(await getSchemeVersion(userId)).toBe(2)
  })
})
