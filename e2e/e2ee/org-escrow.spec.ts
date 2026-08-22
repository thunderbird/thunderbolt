/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Org escrow POC (THU-804). Requires the PowerSync + Postgres harness with
 * ORG_ESCROW_ENABLED wired in playwright.e2ee.config.ts. Run with:
 *   bash scripts/run-e2ee-powersync.sh org-escrow.spec.ts
 *
 * Proves the full escrow loop: first-device setup persists an org envelope
 * wrapping the AK to the operator public key, and the standalone offline
 * decrypt tool (holding only the private key + a DB connection) recovers the
 * plaintext of a synced encrypted row.
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { expect, test } from './fixtures'
import { getTaskIds, waitForNewEncryptedTasks, waitForOrgEnvelope, waitForUserId } from './db'
import { completeFirstDeviceSetup, createE2eeEmail, createTask, enableTasks, loginViaConsumerOtp } from './helpers'
import { testOrgEscrowFingerprint, testOrgEscrowPrivateKey } from './org-escrow-key'

const execFileAsync = promisify(execFile)

const postgresPort = process.env.E2E_POSTGRES_PORT ?? '5434'
const databaseUrl = `postgresql://postgres:postgres@localhost:${postgresPort}/postgres`

/** Run the offline operator decrypt tool and return its stdout (the plaintext). */
const runEscrowDecrypt = async (params: { userId: string; table: string; column: string; rowId: string }) => {
  const { stdout } = await execFileAsync('bun', [
    'scripts/org-escrow-decrypt.ts',
    '--user-id',
    params.userId,
    '--table',
    params.table,
    '--column',
    params.column,
    '--row-id',
    params.rowId,
    '--db-url',
    databaseUrl,
    '--private-key',
    testOrgEscrowPrivateKey,
  ])
  return stdout.trim()
}

test.describe.serial('PowerSync E2EE org escrow', () => {
  test('first-device setup escrows the AK and the offline tool recovers row plaintext', async ({ page }) => {
    const email = createE2eeEmail()
    const taskText = `Escrowed task ${crypto.randomUUID()}`

    await loginViaConsumerOtp(page, email)
    const userId = await waitForUserId(email)
    await completeFirstDeviceSetup(page)

    // Setup must have persisted the org envelope, tagged with the operator key's fingerprint.
    const orgEnvelope = await waitForOrgEnvelope(userId)
    expect(orgEnvelope.keyFingerprint).toBe(testOrgEscrowFingerprint)

    await enableTasks(page)
    const taskIdsBeforeCreate = await getTaskIds(userId)
    await createTask(page, taskText)

    const newServerRows = await waitForNewEncryptedTasks(userId, taskIdsBeforeCreate)
    expect(newServerRows.length).toBeGreaterThan(0)
    const encryptedRow = newServerRows[0]
    expect(encryptedRow.item).toMatch(/^__enc:v2:0:/)
    expect(encryptedRow.item).not.toContain(taskText)

    // The out-of-band recovery: only the operator private key + DB access.
    const plaintext = await runEscrowDecrypt({
      userId,
      table: 'tasks',
      column: 'item',
      rowId: encryptedRow.id,
    })
    expect(plaintext).toContain(taskText)
  })
})
