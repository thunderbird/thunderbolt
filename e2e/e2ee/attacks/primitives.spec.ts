/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Self-test for the adversary toolkit — not an attack.
 *
 * The primitives in db.ts and helpers.ts are what every attack spec and every
 * live hunt is built on, so they must be known-good before a finding rests on
 * them. Asserts only server-side and local-storage facts; what the CLIENT does
 * when it meets tampered data is the attacks' job, not this file's.
 *
 * Requires the PowerSync + Postgres harness. Run with:
 *   bash scripts/run-e2ee-powersync.sh attacks/primitives.spec.ts
 */

import { expect, test } from '../fixtures'
import {
  getTaskIds,
  readCell,
  swapCells,
  waitForEncryptedSetting,
  waitForNewEncryptedTasks,
  waitForUserId,
  writeCell,
  type CellRef,
} from '../db'
import {
  completeFirstDeviceSetup,
  createE2eeEmail,
  createTask,
  enableTasks,
  getEncryptionKeyNames,
  loginViaConsumerOtp,
  revokedDeviceContext,
  stolenSessionContext,
} from '../helpers'

const taskItem = (rowId: string): CellRef => ({ table: 'tasks', rowId, column: 'item' })

test.describe.serial('adversary primitives', () => {
  test('readCell, writeCell and swapCells manipulate stored ciphertext', async ({ page }) => {
    const email = createE2eeEmail()

    await loginViaConsumerOtp(page, email)
    const userId = await waitForUserId(email)
    await completeFirstDeviceSetup(page)
    await enableTasks(page)
    await waitForEncryptedSetting(userId, 'experimental_feature_tasks')

    const before = await getTaskIds(userId)
    await createTask(page, `first ${crypto.randomUUID()}`)
    const [first] = await waitForNewEncryptedTasks(userId, before)

    const afterFirst = await getTaskIds(userId)
    await createTask(page, `second ${crypto.randomUUID()}`)
    const [second] = await waitForNewEncryptedTasks(userId, afterFirst)

    const firstCiphertext = await readCell(taskItem(first.id))
    const secondCiphertext = await readCell(taskItem(second.id))
    expect(firstCiphertext).toMatch(/^__enc:v2:0:/)
    expect(secondCiphertext).not.toEqual(firstCiphertext)

    await swapCells(taskItem(first.id), taskItem(second.id))
    expect(await readCell(taskItem(first.id))).toEqual(secondCiphertext)
    expect(await readCell(taskItem(second.id))).toEqual(firstCiphertext)

    await writeCell(taskItem(first.id), firstCiphertext)
    expect(await readCell(taskItem(first.id))).toEqual(firstCiphertext)

    await expect(readCell(taskItem('00000000-0000-0000-0000-000000000000'))).rejects.toThrow('not found')
  })

  test('a revoked device keeps its local key material (the A4 premise)', async ({ browser, page }) => {
    const email = createE2eeEmail()

    await loginViaConsumerOtp(page, email)
    const userId = await waitForUserId(email)
    await completeFirstDeviceSetup(page)

    const revoked = await revokedDeviceContext(browser, page, { email, userId, profile: 'firefox' })
    try {
      // Revocation deletes the server envelope and rotates AK+DEK; it cannot
      // reach this context's IndexedDB. If this ever fails, C5's attack surface
      // shrank and the threat model should say so.
      expect(await getEncryptionKeyNames(revoked.page)).toEqual(
        expect.arrayContaining(['thunderbolt_ak', 'thunderbolt_dek_0']),
      )
    } finally {
      await revoked.context.close()
    }
  })

  test('a stolen session holds no key material (the A5 premise)', async ({ browser, page }) => {
    const email = createE2eeEmail()

    await loginViaConsumerOtp(page, email)
    await waitForUserId(email)
    await completeFirstDeviceSetup(page)

    const stolen = await stolenSessionContext(browser, email)
    try {
      const keys = await getEncryptionKeyNames(stolen.page)
      expect(keys).not.toContain('thunderbolt_ak')
      expect(keys).not.toContain('thunderbolt_dek_0')
    } finally {
      await stolen.context.close()
    }
  })
})
