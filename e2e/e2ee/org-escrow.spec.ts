/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Requires the PowerSync + Postgres harness. Run with:
 *   bash scripts/run-e2ee-powersync.sh org-escrow.spec.ts
 * (boots docker-compose, waits for readiness, then runs playwright.e2ee.config.ts,
 * which enables ORG_KMS_ESCROW_ENABLED for the shared backend and generates the
 * static test keypair this spec decrypts with).
 *
 * Enterprise KMS Key-Escrow POC (docs/architecture/e2e-encryption.md#enterprise-kms-escrow-poc).
 * Proves the whole escrow loop end to end: the browser wraps the AK for
 * the org's KMS public key during first-device setup, the server persists that
 * envelope, and an operator holding ONLY the KMS private key — never any of the
 * app's own crypto material — can recover real plaintext through the standalone
 * decrypt tool (scripts/kms-escrow-decrypt.ts), entirely out-of-band from the
 * running app.
 */

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from './fixtures'
import { databaseUrl, getTaskIds, waitForNewEncryptedTasks, waitForOrgEnvelope, waitForUserId } from './db'
import { completeFirstDeviceSetup, createE2eeEmail, createTask, enableTasks, loginViaConsumerOtp } from './helpers'
import { getOrgKmsTestKeypair } from './kms-test-keypair'

// Same keypair playwright.e2ee.config.ts gave the backend — see
// kms-test-keypair.ts for how the two processes agree on it.
const { publicKeyBase64: orgPublicKey, privateKeyBase64: orgKmsStaticPrivateKey } = getOrgKmsTestKeypair()

// Resolved off this file, not the launcher's cwd, so the script path holds however
// Playwright was started. `fileURLToPath` and not `.pathname`: the latter stays
// percent-encoded, so a checkout under a path with a space yields a bogus cwd.
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

test.describe('PowerSync E2EE org KMS escrow (POC)', () => {
  test('persists an org envelope on first-device setup, decryptable out-of-band with only the KMS private key', async ({
    page,
  }) => {
    const email = createE2eeEmail()
    const taskText = `Playwright org-escrow task ${crypto.randomUUID()}`

    await loginViaConsumerOtp(page, email)
    const userId = await waitForUserId(email)
    await completeFirstDeviceSetup(page)

    const orgEnvelope = await waitForOrgEnvelope(userId)
    // Pin the exact fingerprint: a length check passes for any non-empty string,
    // including one computed over the wrong key, which defeats the column's purpose.
    expect(orgEnvelope.kmsKeyFingerprint).toBe(
      createHash('sha256').update(Buffer.from(orgPublicKey, 'base64')).digest('base64'),
    )
    expect(orgEnvelope.wrappedAk.length).toBeGreaterThan(0)

    await enableTasks(page)
    const taskIdsBeforeCreate = await getTaskIds(userId)
    await createTask(page, taskText)
    const [newTask] = await waitForNewEncryptedTasks(userId, taskIdsBeforeCreate)
    expect(newTask.item).not.toContain(taskText)

    const decrypted = execFileSync(
      'bun',
      [
        'run',
        'scripts/kms-escrow-decrypt.ts',
        '--user-id',
        userId,
        '--table',
        'tasks',
        '--column',
        'item',
        '--row-id',
        newTask.id,
        '--db-url',
        databaseUrl,
      ],
      {
        encoding: 'utf8',
        // Via the environment, never argv — the same way an operator must pass it.
        env: { ...process.env, ORG_KMS_ESCROW_STATIC_PRIVATE_KEY: orgKmsStaticPrivateKey },
        cwd: repoRoot,
        timeout: 60_000,
      },
    ).trim()

    expect(decrypted).toBe(taskText)
  })
})
