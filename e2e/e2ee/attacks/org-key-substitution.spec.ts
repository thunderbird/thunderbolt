/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * THU-866 / A2 — org escrow key substitution (C11, C2). **Claim: the AK must only
 * ever be escrowed to the operator's real key, so an org key the server chose
 * cannot recover account plaintext.**
 *
 * C11 said the client fetches the escrow public key "from the server it is
 * defending against — pinning, TOFU, or out-of-band verification must carry that
 * weight." Nothing carried it: `buildOrgEnvelope` (src/services/encryption.ts)
 * passed whatever `GET /encryption/org-key` returned straight into `wrapAKForOrg`,
 * and branched only on that same response's `enabled` flag. A2's defining power —
 * "lies about ... org-escrow public key" — was enough to escrow every account's AK
 * to a key the attacker holds, on ANY deployment, including one that configured no
 * escrow at all. Executed end to end at commit `eba7a3fb` (the pre-migration
 * version of this spec), the attacker's private key recovered row plaintext while
 * the legitimate operator key no longer could — escrow was redirected, not
 * duplicated — and the stored `key_fingerprint` still read as the legitimate one,
 * so an operator auditing that column got no warning.
 *
 * The fix (THU-866) removes the server from the decision. The wrap target is the
 * key this BUILD pins (`VITE_ORG_ESCROW_PUBLIC_KEY` → `pinnedOrgEscrowPublicKey`):
 * no pin means no envelope, a pin means that key alone. `GET /encryption/org-key`
 * was then deleted outright, along with the server's own escrow key setting, so
 * the channel this spec lies on no longer exists server-side — `serveEvilOrgKey`
 * answers a path nothing serves and nothing requests. TOFU was never an
 * alternative: the first fetch *is* the escrow event, so it would have pinned the
 * attacker's key.
 *
 * The spec substitutes an attacker P-256 keypair on the wire and completes
 * first-device setup. Two secure assertions follow:
 *   1. the attacker's private key cannot recover the row, and
 *   2. the OPERATOR's private key still can.
 *
 * (2) is what makes this a real gate rather than a tautology: after the fix, "the
 * attacker cannot decrypt" would hold just as well if escrow had silently stopped
 * happening. The `waitForOrgEnvelope` fingerprint check above it is a weaker guard
 * on the same point — the backend stamps its own configured fingerprint over an
 * envelope it never validates (`persistOrgEnvelope`), so that column proves the row
 * exists, not what it is wrapped to. Only (2) is cryptographic.
 *
 * Capability audit: A2 only — a lie on the wire for `GET /encryption/org-key`
 * (`serveEvilOrgKey`), intercepted in the browser via `context.route`, so it stands
 * whether or not the backend still implements that path. That is what keeps this a
 * live tripwire: if a client ever re-acquires a fetch of it, the lie lands again and
 * this spec fails. No key material, no session theft, no device access; the attacker
 * keypair is generated fresh per run.
 *
 * Polarity: asserts the SECURE behavior. Authored as an Option C expected-failure
 * while the vuln was open; once the pin landed the run reported "Expected to fail,
 * but passed" and the `test.fail()` tag was retired — this is now a permanent green
 * regression gate. Verified to be a real gate, not a vacuous one: with
 * `buildOrgEnvelope` reverted to trust the served key it fails again on (1).
 *
 * Requires the PowerSync + Postgres harness, which runs the backend with
 * ORG_ESCROW_ENABLED and pins the SAME test key into the frontend build. Run with:
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
import { testOrgEscrowPrivateKey } from '../org-escrow-key'

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
  test('a substituted org key cannot redirect the escrowed AK away from the operator', async ({ page }) => {
    const email = createE2eeEmail()
    const taskText = `Escrow-hijacked task ${crypto.randomUUID()}`

    // A2 lies about the org public key: pre-fix the client wrapped the AK to a key
    // only the attacker holds the private half of.
    const attacker = await generateAttackerEscrowKeypair()
    await serveEvilOrgKey(page.context(), { publicKey: attacker.publicKey, fingerprint: attacker.fingerprint })

    await loginViaConsumerOtp(page, email)
    const userId = await waitForUserId(email)
    await completeFirstDeviceSetup(page)

    // Escrow still ran under the lie. Presence only — assertion 2 below is what
    // establishes which key it landed on.
    const orgEnvelope = await waitForOrgEnvelope(userId)
    expect(orgEnvelope.wrappedAk.length).toBeGreaterThan(0)

    await enableTasks(page)
    const taskIdsBefore = await getTaskIds(userId)
    await createTask(page, taskText)
    const newRows = await waitForNewEncryptedTasks(userId, taskIdsBefore)
    expect(newRows.length).toBeGreaterThan(0)
    const encryptedRow = newRows[0]
    expect(encryptedRow.item).toMatch(/^__enc:v2:0:/)
    expect(encryptedRow.item).not.toContain(taskText)
    const cell = { userId, table: 'tasks', column: 'item', rowId: encryptedRow.id }

    // 1. Escrow must never hand the AK to a key the server chose.
    await expect(runEscrowDecrypt({ ...cell, privateKey: attacker.privateKey })).rejects.toThrow()

    // 2. And the operator's own key must still open it — the substitution was
    // ignored, not answered by dropping escrow altogether.
    expect(await runEscrowDecrypt({ ...cell, privateKey: testOrgEscrowPrivateKey })).toContain(taskText)
  })
})
