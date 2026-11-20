/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * A5 + a leaked v1 canary secret — v1 account takeover through the upgrade.
 * **Claim holds.**
 *
 * A pending device may upgrade a v1 account when the user types the v1 phrase,
 * which is the raw CK. The server cannot see the CK: the only possession proof
 * it checks is the canary secret, which is static and which every v1 client sent
 * in plain on approve, deny, revoke and node-id requests. So anyone who ever saw
 * that secret, holding a session for the account, could otherwise upgrade it from
 * a device they control: demote every trusted device, own the new phrase, and
 * plant a bogus `"v1"` slot that leaves the legacy data unreadable for good.
 *
 * The emailed step-up code is what stops it. This spec replays a valid secret
 * from a pending device without a code and shows the upgrade refused with the
 * account still on scheme 1 and its trusted device untouched. The code matrix
 * (missing, wrong, valid, consumed) is unit-tested in
 * `backend/src/api/encryption-v2.test.ts`; the legitimate flow with inbox access
 * is the v1-phrase recovery in `e2ee/migration.spec.ts`.
 *
 * Requires the PowerSync + Postgres harness. Run with:
 *   bash scripts/run-e2ee-powersync.sh attacks/v1-upgrade-canary-replay.spec.ts
 */

import { expect, test } from '../fixtures'
import { getSchemeVersion, waitForDeviceKeys, waitForDeviceState, waitForUserId } from '../db'
import {
  createE2eeEmail,
  createIsolatedDevice,
  encryptionApiRequest,
  getDeviceId,
  loginViaConsumerOtp,
  registerDeviceOnly,
  seedV1Account,
  startAdditionalDeviceSetup,
} from '../helpers'

test.describe.serial('A5 — v1 upgrade with a replayed canary secret', () => {
  test('a pending device holding the canary secret but no step-up code cannot upgrade the account', async ({
    browser,
    page,
  }) => {
    const email = createE2eeEmail()
    await loginViaConsumerOtp(page, email)
    const userId = await waitForUserId(email)
    await registerDeviceOnly(page)
    const [victimKeys] = await waitForDeviceKeys(userId, 1)
    const { canarySecret } = await seedV1Account(userId, [victimKeys])

    const attacker = await createIsolatedDevice(browser, 'firefox')
    try {
      await loginViaConsumerOtp(attacker.page, email)
      await startAdditionalDeviceSetup(attacker.page)
      const attackerId = await getDeviceId(attacker.page)
      await waitForDeviceState(userId, attackerId, (state) => state.approvalPending)

      const challenge = await encryptionApiRequest(attacker.page, '/encryption/challenge?operation=upgrade', {
        deviceId: attackerId,
      })
      expect(challenge.status).toBe(200)
      const { nonce } = challenge.body as { nonce: string }

      const upgrade = await encryptionApiRequest(attacker.page, '/encryption/upgrade', {
        method: 'POST',
        deviceId: attackerId,
        body: {
          nonce,
          possessionProof: canarySecret,
          envelopes: [{ deviceId: attackerId, wrappedCK: 'attacker-ak', attestation: 'attacker-attestation' }],
          wrappedKeys: [
            { keyId: '0', wrappedKey: 'attacker-dek-0' },
            { keyId: 'v1', wrappedKey: 'bogus-v1-slot' },
          ],
          primaryKeyId: '0',
          canaryIv: 'attacker-iv',
          canaryCtext: 'attacker-ctext',
          signingPublicKey: 'attacker-signing-key',
          kdfSalt: 'attacker-salt',
          recoveryEcdhPublicKey: 'attacker-ecdh',
          recoveryMlkemPublicKey: 'attacker-mlkem',
          recoveryWrappedAK: 'attacker-recovery-ak',
          recoveryAttestation: 'attacker-recovery-attestation',
        },
      })

      expect(upgrade.status).toBe(403)
      expect((upgrade.body as { code?: string }).code).toBe('step_up_required')
      expect(await getSchemeVersion(userId)).toBe(1)
      await waitForDeviceState(userId, victimKeys.deviceId, (state) => state.trusted && state.hasEnvelope)
      await waitForDeviceState(userId, attackerId, (state) => !state.trusted)
    } finally {
      await attacker.context.close()
    }
  })
})
