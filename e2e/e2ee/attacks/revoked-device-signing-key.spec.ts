/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * THU-872 — a revoked device re-derives the account's CURRENT signing key
 * (C9 primary / C5 secondary, adversary A2 + A4 collusion, High).
 *
 * **Claim: after a revocation-triggered AK rotation, the account's signing key
 * must NOT be derivable from material the revoked device still holds.**
 *
 * Rotating the AK is supposed to be what revocation denies a device. It does not
 * deny it the signing key, because the signing key does not depend on the AK:
 *
 *   - the signing key is `HKDF(canary secret)`, deterministic (`deriveSigningKeyPair`);
 *   - the canary is re-minted under DEK-0 on every rotation
 *     (`src/services/encryption.ts`, `createCanary(dek0, userId, initialKeyId)`);
 *   - DEK-0's MATERIAL never changes — a rotation only re-wraps it;
 *   - a revoked device opens DEK-0 locally with its OLD AK and never calls the
 *     server: `getWrappedDek0` reads the staged blob first, and while
 *     `pruneStagedDEKs` exists it always keeps `"0"` and runs only inside
 *     `applyKeyring`, which a revoked device never reaches.
 *
 * So the re-mint that `revoked-device-identity.spec.ts` records as the protection
 * is not one: the secret changes, but the revoked device can compute the new one.
 *
 * Payoff (not asserted here — this spec witnesses the enabling capability). The
 * signing key authenticates the recovery anchor, and `readStoredRecoveryPlan`
 * verifies it cryptographically with NO device-state gate. A revoked device signs
 * an anchor naming A2's own recovery keypair; the next routine revoke verifies
 * that attestation, `buildRecoverySlot` wraps the NEW AK to A2's keypair, and A2
 * unwraps the account. The trigger is the victim's own revoke and nothing warns.
 * That is why THU-865's anchor is only sound against an attacker who does not
 * also hold a revoked device.
 *
 * Capability audit: A4 supplies only its own retained IndexedDB (AK +
 * `thunderbolt_dek_0`), which `revoked-device-identity.spec.ts` already proves it
 * keeps. A2 supplies the post-rotation canary envelope, read straight from
 * `encryption_metadata` — the route is NOT used, because a colluding server owns
 * the row. That is deliberate: `attacks/canary-route-ungated.spec.ts` covers the
 * route as metadata hygiene, and gating it does not affect this spec.
 *
 * Fidelity: no crypto is re-implemented. The page does only AES-KW unwrap +
 * AES-GCM decrypt (plain WebCrypto, exactly as the SharedWorker does), and the
 * HKDF -> P-256 step calls the app's own `deriveSigningKeyPair` in the spec
 * process. `canaryAAD` comes from `@shared/e2ee-types`, so the AAD layout cannot
 * drift from production. This is what lets the full exploit be spec'd at L1
 * rather than argued by composition.
 *
 * Expected-failure (Option C): this asserts the SECURE behavior — the recovered
 * canary secret does NOT yield the account's live `signing_public_key` — and is
 * tagged `test.fail()` because it DOES today. When THU-872 is fixed (signing key
 * stored as random material wrapped under the rotating AK), the derivation stops
 * matching, the assertion passes, and Playwright flags the unexpected pass ->
 * drop the `test.fail()` tag for a permanent regression gate.
 *
 * Requires the PowerSync + Postgres harness. Run with:
 *   bash scripts/run-e2ee-powersync.sh attacks/revoked-device-signing-key.spec.ts
 */

import { canaryAAD } from '@shared/e2ee-types'
import { deriveSigningKeyPair } from '@/crypto/canary'

import { expect, test } from '../fixtures'
import {
  getCanaryCiphertext,
  getEncryptionServerSnapshot,
  getSigningPublicKey,
  waitForConsumedChallenge,
  waitForDeviceState,
  waitForUserId,
} from '../db'
import {
  completeFirstDeviceSetup,
  createE2eeEmail,
  getEncryptionKeyNames,
  loginViaConsumerOtp,
  revokeTrustedDevice,
  trustAdditionalDevice,
} from '../helpers'

/** The canary plaintext prefix the recovered secret must sit behind (v2 codec). */
const canaryPrefix = 'thunderbolt-canary-v2'

/**
 * A4's whole move, executed inside the revoked context with nothing but what it
 * retained plus the envelope A2 relayed: unwrap DEK-0 with the retained AK, then
 * AES-GCM-decrypt the post-rotation canary under the AAD the app would use.
 *
 * Returns the staged wrapped DEK-0 blob alongside the plaintext so the caller can
 * pin the epoch: AES-KW is deterministic, so a blob that differs from the
 * post-rotation server copy proves this material is wrapped under the OLD AK.
 * Without that check the spec cannot distinguish "opens the new canary with its
 * old AK" (the finding) from "revocation failed to lock it out at all" (a much
 * louder bug), because DEK-0's material is identical either way.
 *
 * `plaintext` is null when the decrypt fails — which is what a fix that re-keys
 * the canary off DEK-0 would produce, and is reported rather than thrown so the
 * assertion reads on the security property instead of on an exception.
 */
const recoverCanarySecretFromRevokedDevice = async (
  page: import('@playwright/test').Page,
  envelope: { iv: string; ctext: string },
  aad: number[],
): Promise<{ plaintext: string | null; wrappedDek0: string | null }> =>
  page.evaluate(
    async ({ iv, ctext, aad }) => {
      // Annotated `Uint8Array<ArrayBuffer>` so TS narrows the backing buffer to
      // BufferSource at every WebCrypto call site (the same copy-to-narrow dance
      // `verifyRecoveryAttestation` does in src/crypto/canary.ts).
      const fromBase64 = (value: string): Uint8Array<ArrayBuffer> =>
        Uint8Array.from(atob(value), (character) => character.charCodeAt(0))

      const request = indexedDB.open('thunderbolt-keys')
      const database = await new Promise<IDBDatabase>((resolve, reject) => {
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
      })
      const store = database.transaction('keys', 'readonly').objectStore('keys')
      const read = <T>(id: string): Promise<T | undefined> =>
        new Promise((resolve, reject) => {
          const getRequest = store.get(id)
          getRequest.onsuccess = () => resolve(getRequest.result as T | undefined)
          getRequest.onerror = () => reject(getRequest.error)
        })
      // The AK is non-extractable, which is irrelevant here: unwrapping is a
      // permitted operation on it, and that is all a revoked device needs.
      const ak = await read<CryptoKey>('thunderbolt_ak')
      const wrappedDek0 = await read<string>('thunderbolt_dek_0')
      database.close()
      if (!ak || !wrappedDek0) {
        return { plaintext: null, wrappedDek0: wrappedDek0 ?? null }
      }

      try {
        const dek0 = await crypto.subtle.unwrapKey(
          'raw',
          fromBase64(wrappedDek0),
          ak,
          'AES-KW',
          { name: 'AES-GCM', length: 256 },
          false,
          ['decrypt'],
        )
        const plaintext = await crypto.subtle.decrypt(
          { name: 'AES-GCM', iv: fromBase64(iv), additionalData: new Uint8Array(aad) },
          dek0,
          fromBase64(ctext),
        )
        return { plaintext: new TextDecoder().decode(plaintext), wrappedDek0 }
      } catch {
        return { plaintext: null, wrappedDek0 }
      }
    },
    { iv: envelope.iv, ctext: envelope.ctext, aad },
  )

test.describe.serial('THU-872 — revoked device re-derives the current signing key', () => {
  test('a revoked device cannot derive the signing key the account uses after rotation', async ({ browser, page }) => {
    // Expected-failure while the vuln is open — see the file header (Option C).
    test.fail()

    const email = createE2eeEmail()

    await loginViaConsumerOtp(page, email)
    const userId = await waitForUserId(email)
    await completeFirstDeviceSetup(page)

    // A4: a device that held full trust, with its context left open so it keeps
    // the AK and the staged keyring revocation cannot reach.
    const victim = await trustAdditionalDevice(browser, page, { email, userId, profile: 'firefox' })
    try {
      const before = await getEncryptionServerSnapshot(userId)
      const signingKeyBefore = await getSigningPublicKey(userId)
      expect(signingKeyBefore).not.toBeNull()

      await revokeTrustedDevice(page, victim.label)
      await waitForConsumedChallenge(userId, 'revoke')
      await waitForDeviceState(userId, victim.deviceId, (state) => state.revokedAt !== null)

      // `revokeDeviceAndRotate` revokes first and rotates second, so poll for the
      // rotation rather than reading once — a single read passes idle and fails
      // under suite load.
      await expect
        .poll(async () => (await getEncryptionServerSnapshot(userId)).keyVersion, { timeout: 30_000 })
        .toBeGreaterThan(before.keyVersion)

      // Non-vacuity: the rotation really happened and really re-minted the
      // signing identity, so this spec is not passing because nothing changed.
      const signingKeyAfter = await getSigningPublicKey(userId)
      expect(signingKeyAfter).not.toEqual(signingKeyBefore)
      const after = await getEncryptionServerSnapshot(userId)
      expect(after.primaryKeyId).not.toEqual(before.primaryKeyId)

      // The derivation input survives the rotation in the revoked context.
      expect(await getEncryptionKeyNames(victim.page)).toEqual(
        expect.arrayContaining(['thunderbolt_ak', 'thunderbolt_dek_0']),
      )

      // A2 relays the post-rotation canary envelope out of the row it owns. No
      // route, no session — `revokeDeviceSessions` already deleted A4's session.
      const envelope = await getCanaryCiphertext(userId)
      const { plaintext, wrappedDek0 } = await recoverCanarySecretFromRevokedDevice(victim.page, envelope, [
        ...canaryAAD(userId, '0'),
      ])

      // Epoch pin: the rotation re-wrapped DEK-0 under the new AK, and AES-KW is
      // deterministic, so the victim holding a DIFFERENT blob proves its material
      // is the pre-rotation wrapping — i.e. it really was locked out and is
      // opening the new canary with its OLD AK, which is the finding. Without
      // this the assertion below would also pass if revocation had simply failed.
      expect(wrappedDek0).not.toBeNull()
      expect(wrappedDek0).not.toEqual(after.wrappedKeys['0'])

      // Non-vacuity: if the canary did not decrypt at all, this spec proves
      // nothing about the signing key and must not pass by accident. A fix that
      // legitimately re-keys the canary off DEK-0 should be spec'd as its own
      // secure assertion rather than passing silently here.
      expect(plaintext, 'revoked device could not decrypt the canary — assertion below would be vacuous').not.toBeNull()
      expect(plaintext!.startsWith(`${canaryPrefix}:`)).toBe(true)

      const recoveredSecret = plaintext!.slice(canaryPrefix.length + 1)
      const { publicKeySpki } = await deriveSigningKeyPair(recoveredSecret)

      // SECURE assertion: material the revoked device holds must not yield the
      // account's live signing identity. Fails today — they are equal, which is
      // the whole finding. Passes once the signing key is random material wrapped
      // under the rotating AK. Unaffected by device-gating GET /encryption/canary,
      // which is why this spec cannot produce a false green for that change.
      expect(publicKeySpki).not.toEqual(signingKeyAfter)
    } finally {
      await victim.context.close()
    }
  })
})
