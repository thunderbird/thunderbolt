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
 * Fidelity: no crypto is re-implemented. The page does only an AES-GCM DEK
 * unwrap + AES-GCM decrypt (plain WebCrypto, exactly as the SharedWorker does),
 * and the HKDF -> P-256 step calls the app's own `deriveSigningKeyPair` in the
 * spec process. `canaryAAD` and `dekWrapAAD` come from `@shared/e2ee-types`, so
 * neither AAD layout can drift from production. This is what lets the full
 * exploit be spec'd at L1 rather than argued by composition.
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

import { canaryAAD, dekWrapAAD } from '@shared/e2ee-types'
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
 * Also pins the epoch: it additionally tries to unwrap the POST-ROTATION server
 * copy of DEK-0 under the retained AK. That must FAIL (`serverBlobOpens: false`)
 * — the rotation re-wrapped the row under a new AK this device was denied —
 * while the LOCAL staged blob opens. Without that pin the spec cannot
 * distinguish "opens the new canary with its old AK" (the finding) from
 * "revocation failed to lock it out at all" (a much louder bug), because DEK-0's
 * material is identical either way. (This used to compare blob bytes, which
 * worked because AES-KW was deterministic; the THU-893 AAD-bound GCM wrapping
 * has a random IV, so equality is vacuous and the pin unwraps instead.)
 *
 * `plaintext` is null when the decrypt fails — which is what a fix that re-keys
 * the canary off DEK-0 would produce, and is reported rather than thrown so the
 * assertion reads on the security property instead of on an exception.
 */
const recoverCanarySecretFromRevokedDevice = async (
  page: import('@playwright/test').Page,
  envelope: { iv: string; ctext: string },
  aad: number[],
  wrapAad: number[],
  serverWrappedDek0: string,
): Promise<{ plaintext: string | null; hasLocalDek0: boolean; serverBlobOpens: boolean }> =>
  page.evaluate(
    async ({ iv, ctext, aad, wrapAad, serverWrappedDek0 }) => {
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

      // The DEK wrap format since THU-893: base64(iv(12) ‖ AES-GCM(raw DEK))
      // with `dekWrapAAD(keyId)` bound as AAD — mirrored here byte-for-byte
      // because a revoked client is exactly as capable of following the format
      // as a trusted one.
      const unwrapDek0 = async (wrappingKey: CryptoKey, blobBase64: string): Promise<CryptoKey> => {
        const blob = fromBase64(blobBase64)
        return crypto.subtle.unwrapKey(
          'raw',
          blob.slice(12),
          wrappingKey,
          { name: 'AES-GCM', iv: blob.slice(0, 12), additionalData: new Uint8Array(wrapAad) },
          { name: 'AES-GCM', length: 256 },
          false,
          ['decrypt'],
        )
      }

      if (!ak || !wrappedDek0) {
        return { plaintext: null, hasLocalDek0: Boolean(wrappedDek0), serverBlobOpens: false }
      }

      const serverBlobOpens = await unwrapDek0(ak, serverWrappedDek0).then(
        () => true,
        () => false,
      )

      try {
        const dek0 = await unwrapDek0(ak, wrappedDek0)
        const plaintext = await crypto.subtle.decrypt(
          { name: 'AES-GCM', iv: fromBase64(iv), additionalData: new Uint8Array(aad) },
          dek0,
          fromBase64(ctext),
        )
        return { plaintext: new TextDecoder().decode(plaintext), hasLocalDek0: true, serverBlobOpens }
      } catch {
        return { plaintext: null, hasLocalDek0: true, serverBlobOpens }
      }
    },
    { iv: envelope.iv, ctext: envelope.ctext, aad, wrapAad, serverWrappedDek0 },
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
      const { plaintext, hasLocalDek0, serverBlobOpens } = await recoverCanarySecretFromRevokedDevice(
        victim.page,
        envelope,
        [...canaryAAD(userId, '0')],
        [...dekWrapAAD('0')],
        after.wrappedKeys['0'],
      )

      // Epoch pin: the rotation re-wrapped DEK-0 under the new AK, so the
      // victim's retained AK must FAIL on the post-rotation server copy while
      // its own staged blob opens — i.e. it really was locked out and is opening
      // the new canary with its OLD AK, which is the finding. Without this the
      // assertion below would also pass if revocation had simply failed.
      expect(hasLocalDek0).toBe(true)
      expect(serverBlobOpens).toBe(false)

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
