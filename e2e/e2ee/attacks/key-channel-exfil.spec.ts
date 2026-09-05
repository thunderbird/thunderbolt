/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * A5 — same-origin key exfiltration via the keys-sync channel (C13). **Claim holds.**
 *
 * Adversary A6 is a hostile same-origin script/tab. It can open the
 * `thunderbolt-keys-sync` BroadcastChannel and read/post on it. C13 says that
 * buys nothing: the channel is a CONTROL channel — every message is
 * `{ type, keyId?, reason? }` (src/db/encryption/codec.ts `KeysSyncMessage`),
 * never key material — and each one only drops caches so the codec re-reads the
 * authoritative IndexedDB. No message injects a key.
 *
 * Test 1 fires the whole hostile message set, including `reset` (which clears the
 * in-memory setup flag). Encode still fails CLOSED — `encodeWithoutKeys` refuses
 * plaintext while a persisted AK exists — so a new write stays `__enc:v2:`+AAD
 * and prior data still decrypts. The forged barrage injected nothing and forced
 * no plaintext.
 *
 * Test 2 covers C13's "no fail-open on an unknown key_id": a cell tagged with a
 * key_id the keyring does not hold drives the key-request → stage → still-missing
 * path, and decode fails SAFE to the raw wire value — never plaintext, never a
 * hang.
 *
 * Requires the PowerSync + Postgres harness. Run with:
 *   bash scripts/run-e2ee-powersync.sh attacks/key-channel-exfil.spec.ts
 */

import { expect, test } from '../fixtures'
import { getTaskCiphertext, getTaskIds, waitForUserId, writeCell } from '../db'
import { completeFirstDeviceSetup, createE2eeEmail, createTask, enableTasks, loginViaConsumerOtp } from '../helpers'
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

test.describe.serial('A5 — keys-sync channel exfiltration', () => {
  test('a forged keys-sync barrage cannot force plaintext or corrupt the keyring', async ({ page }) => {
    const email = createE2eeEmail()
    const secretA = `channel-secretA-${crypto.randomUUID()}`
    const secretB = `channel-secretB-${crypto.randomUUID()}`

    await loginViaConsumerOtp(page, email)
    const userId = await waitForUserId(email)
    await completeFirstDeviceSetup(page)
    await enableTasks(page)

    await createTask(page, secretA)
    const [rowA] = await waitForCreatedTaskIds(userId, 1)
    expect(await getTaskCiphertext(rowA)).toMatch(v2Ciphertext)

    // A6 fires every hostile control message it can craft, including `reset`
    // (clears the in-memory setup flag) and forged `key-staged` for an attacker
    // key_id. None carries key material; the union has no slot for one.
    await page.evaluate(() => {
      const channel = new BroadcastChannel('thunderbolt-keys-sync')
      channel.postMessage({ type: 'reset' })
      channel.postMessage({ type: 'invalidate' })
      channel.postMessage({ type: 'key-staged', keyId: '0' })
      channel.postMessage({ type: 'key-staged', keyId: 'attacker' })
      channel.postMessage({ type: 'key-request', keyId: 'attacker', reason: 'unknown-key' })
      channel.postMessage({ type: 'ak-refreshed' })
      channel.close()
    })

    // Encode still fails CLOSED: a persisted AK keeps `encodeWithoutKeys` from
    // ever passing plaintext through, so the new write is real ciphertext.
    await createTask(page, secretB)
    const rows = await waitForCreatedTaskIds(userId, 2)
    const rowB = rows.find((id) => id !== rowA)
    expect(rowB).toBeDefined()
    const ciphertextB = await getTaskCiphertext(rowB!)
    expect(ciphertextB).toMatch(v2Ciphertext)
    expect(ciphertextB).not.toContain(secretB)

    // The keyring is intact — prior data still decrypts, nothing was injected.
    await page.goto('/tasks')
    await expect(page.getByText(secretA, { exact: true })).toBeVisible({ timeout: 30_000 })
  })

  test('a cell tagged with an unknown key_id fails safe to raw, never plaintext', async ({ page }) => {
    const email = createE2eeEmail()
    const secret = `channel-unknown-${crypto.randomUUID()}`

    await loginViaConsumerOtp(page, email)
    const userId = await waitForUserId(email)
    await completeFirstDeviceSetup(page)
    await enableTasks(page)

    await createTask(page, secret)
    const [rowId] = await waitForCreatedTaskIds(userId, 1)

    // Re-tag the SAME ciphertext with a key_id the keyring will never hold. The
    // AAD would mismatch anyway, but the point is the unknown-key_id resolution
    // path: request → stage → still missing → fail safe.
    const real = await getTaskCiphertext(rowId)
    const unknownKeyId = real.replace(v2Ciphertext, '__enc:v2:attacker0:')
    expect(unknownKeyId).toMatch(/^__enc:v2:attacker0:/)
    await writeCell({ table: 'tasks', rowId, column: 'item' }, unknownKeyId)

    // decode returns the raw wire value — the user sees gibberish, never
    // plaintext, and the list stays responsive (default tasks still render).
    await page.goto('/tasks')
    await expect(page.getByText(/^__enc:v2:attacker0:/).first()).toBeVisible({ timeout: 30_000 })
    await expect(page.getByText(secret, { exact: true })).toHaveCount(0)
    await expect(page.getByText('Connect your email account to get started', { exact: true })).toBeVisible()
  })
})
