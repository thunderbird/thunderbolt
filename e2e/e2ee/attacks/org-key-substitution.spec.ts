/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * THU-866 / A2 — org escrow key substitution (C11, C2). **Claim: the AK must only
 * ever be escrowed to the operator's real key, so an org key the server chose
 * cannot recover account plaintext.**
 *
 * C11 says the client fetches the escrow public key "from the server it is
 * defending against — pinning, TOFU, or out-of-band verification must carry
 * that weight." Nothing carries it: `buildOrgEnvelope` (src/services/encryption
 * .ts) passes whatever `GET /encryption/org-key` returns straight into
 * `wrapAKForOrg`, with no pinning, no TOFU, and no fingerprint check. A2's
 * defining power — "lies about ... org-escrow public key" — is enough to escrow
 * every account's AK to a key the attacker holds.
 *
 * This spec substitutes an attacker P-256 keypair on the wire and completes
 * first-device setup. What the failure looks like today, executed end to end at
 * commit `eba7a3fb` (the pre-migration version of this spec):
 *   1. the offline operator tool with the ATTACKER private key recovers row
 *      plaintext (the AK was escrowed to the attacker), and
 *   2. the LEGITIMATE operator key can no longer recover it — escrow was
 *      silently redirected, not duplicated, and
 *   3. the stored `key_fingerprint` is the LEGIT one (the backend stamps its own
 *      via `persistOrgEnvelope`, ignoring the client), so an operator auditing
 *      the fingerprint gets no warning — false assurance.
 *
 * Only (1) is asserted here. (2) and (3) describe behavior a fix is free to
 * change — a client that refuses to escrow against an unpinned key may persist no
 * envelope at all — so asserting them would pin this spec to one fix shape. For
 * the same reason there is no `waitForOrgEnvelope` barrier: it throws on timeout,
 * and under a refuse-to-escrow fix that throw would hold this spec at
 * expected-failure forever instead of letting it flip.
 *
 * Capability audit: A2 only — a lie on the wire for `GET /encryption/org-key`
 * (`serveEvilOrgKey`). No key material, no session theft, no device access; the
 * attacker keypair is generated fresh per run.
 *
 * Expected-failure (Option C): this test asserts the SECURE behavior — the
 * attacker's private key cannot recover the plaintext — and is tagged
 * `test.fail()` because the vuln is open today, so that assertion fails now (the
 * attacker key decrypts fine). When THU-866 is fixed (pin or TOFU the org key),
 * the decrypt fails, the assertion passes, and Playwright flags the unexpected
 * pass → drop the `test.fail()` tag for a permanent regression gate.
 *
 * Requires the PowerSync + Postgres harness with ORG_ESCROW_ENABLED. Run with:
 *   bash scripts/run-e2ee-powersync.sh attacks/org-key-substitution.spec.ts
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { expect, test } from '../fixtures'
import { getTaskIds, waitForNewEncryptedTasks, waitForUserId } from '../db'
import {
  completeFirstDeviceSetup,
  createE2eeEmail,
  createTask,
  enableTasks,
  loginViaConsumerOtp,
  serveEvilOrgKey,
} from '../helpers'

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
    // Expected-failure while the vuln is open — see the file header (Option C).
    test.fail()

    const email = createE2eeEmail()
    const taskText = `Escrow-hijacked task ${crypto.randomUUID()}`

    // A2 lies about the org public key: the client wraps the AK to a key only
    // the attacker holds the private half of.
    const attacker = await generateAttackerEscrowKeypair()
    await serveEvilOrgKey(page.context(), { publicKey: attacker.publicKey, fingerprint: attacker.fingerprint })

    await loginViaConsumerOtp(page, email)
    const userId = await waitForUserId(email)
    await completeFirstDeviceSetup(page)

    await enableTasks(page)
    const taskIdsBefore = await getTaskIds(userId)
    await createTask(page, taskText)
    const newRows = await waitForNewEncryptedTasks(userId, taskIdsBefore)
    expect(newRows.length).toBeGreaterThan(0)
    const encryptedRow = newRows[0]
    expect(encryptedRow.item).toMatch(/^__enc:v2:0:/)
    expect(encryptedRow.item).not.toContain(taskText)

    // SECURE assertion: escrow must never hand the AK to a key the server chose,
    // so the attacker's private key must not recover the row. Fails today (it
    // recovers the plaintext); passes once THU-866 pins or TOFUs the org key.
    await expect(
      runEscrowDecrypt({
        userId,
        table: 'tasks',
        column: 'item',
        rowId: encryptedRow.id,
        privateKey: attacker.privateKey,
      }),
    ).rejects.toThrow()
  })
})
