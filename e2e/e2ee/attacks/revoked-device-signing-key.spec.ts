/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * THU-872 — a revoked device re-derives the account's CURRENT signing key
 * (C9 primary / C5 secondary, adversary A2 + A4 collusion — FIXED, permanent gate).
 *
 * **Claim: after a revocation-triggered AK rotation, the account's signing key
 * must NOT be derivable from material the revoked device still holds.**
 *
 * The vulnerable design anchored the canary to DEK-0: the signing key was
 * `HKDF(canary secret)`, the canary was re-minted under DEK-0 on every
 * rotation, and DEK-0's MATERIAL never changes — so a revoked device opened
 * DEK-0 locally with its retained AK and computed every future signing key.
 * The re-mint that `revoked-device-identity.spec.ts` records as the protection
 * was not one: the secret changed, but the revoked device could re-derive it.
 *
 * The fix (THU-872) anchors the canary to the ACCOUNT KEY: the seed is wrapped
 * under the AK with `canaryAAD(userId, akCanaryAnchor)`, and every revocation
 * re-mints the AK — which is exactly the key a revoked device is denied. The
 * signing key derives from the unwrapped seed, so "can this device derive the
 * current signing key?" reduces to "can it open the current canary?", and for
 * a revoked device the answer must be no.
 *
 * What this spec witnesses, in one run:
 *   1. EPOCH PIN — the rotation really locked the victim out: the post-rotation
 *      server copy of DEK-0 does NOT open under its retained AK, while its own
 *      staged blob still does (so a failure below is the fix, not a broken
 *      harness or a failed revocation).
 *   2. EXPLOIT ARM — the revoked context attempts the AK-anchored unwrap of the
 *      post-rotation canary with its retained AK, and the legacy DEK-0 decrypt
 *      under the old `canaryAAD(userId, '0')`. Both must fail.
 *   3. POSITIVE CONTROL — the trusted device that performed the revocation
 *      opens the SAME canary blob under ITS stored (current) AK. This is what
 *      makes the exploit-arm failure meaningful: the artifact is real and
 *      openable, just not by the revoked device.
 *
 * Capability audit: A4 supplies only its own retained IndexedDB (AK +
 * `thunderbolt_dek_0`), which `revoked-device-identity.spec.ts` already proves
 * it keeps. A2 supplies the post-rotation canary envelope, read straight from
 * `encryption_metadata` — the route is NOT used, because a colluding server
 * owns the row (`attacks/canary-route-ungated.spec.ts` covers the route as
 * metadata hygiene).
 *
 * Fidelity: no crypto is re-implemented. The page does AES-GCM unwraps with
 * plain WebCrypto exactly as the app does, and `canaryAAD`/`dekWrapAAD`/
 * `akCanaryAnchor` come from `@shared/e2ee-types`, so no AAD layout can drift
 * from production.
 *
 * History: this was an Option C expected-failure (`test.fail()`) while the
 * vuln was open — the exploit arm then DECRYPTED the DEK-0-anchored canary and
 * derived the account's live `signing_public_key`. The THU-872 fix made the
 * secure assertion pass; the tag is retired and this file is the permanent
 * regression gate (L∞): it reds out if the canary ever re-anchors to material
 * a revoked device retains.
 *
 * Requires the PowerSync + Postgres harness. Run with:
 *   bash scripts/run-e2ee-powersync.sh attacks/revoked-device-signing-key.spec.ts
 */

import { akCanaryAnchor, canaryAAD, dekWrapAAD } from '@shared/e2ee-types'

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

/**
 * Attempt the AK-anchored canary unwrap inside a page context, with whatever AK
 * that context's IndexedDB holds — the exact operation `unwrapCanaryKey` does
 * (`src/crypto/canary.ts`): AES-GCM unwrap of the seed blob into an HKDF handle
 * under `canaryAAD(userId, akCanaryAnchor)`. Returns whether it opened.
 */
const canaryOpensInContext = async (
  page: import('@playwright/test').Page,
  envelope: { iv: string; ctext: string },
  akAad: number[],
): Promise<boolean> =>
  page.evaluate(
    async ({ iv, ctext, akAad }) => {
      const fromBase64 = (value: string): Uint8Array<ArrayBuffer> =>
        Uint8Array.from(atob(value), (character) => character.charCodeAt(0))

      const request = indexedDB.open('thunderbolt-keys')
      const database = await new Promise<IDBDatabase>((resolve, reject) => {
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
      })
      const store = database.transaction('keys', 'readonly').objectStore('keys')
      const ak = await new Promise<CryptoKey | undefined>((resolve, reject) => {
        const getRequest = store.get('thunderbolt_ak')
        getRequest.onsuccess = () => resolve(getRequest.result as CryptoKey | undefined)
        getRequest.onerror = () => reject(getRequest.error)
      })
      database.close()
      if (!ak) {
        return false
      }

      return crypto.subtle
        .unwrapKey(
          'raw',
          fromBase64(ctext),
          ak,
          { name: 'AES-GCM', iv: fromBase64(iv), additionalData: new Uint8Array(akAad) },
          'HKDF',
          false,
          ['deriveBits', 'deriveKey'],
        )
        .then(
          () => true,
          () => false,
        )
    },
    { iv: envelope.iv, ctext: envelope.ctext, akAad },
  )

/**
 * The revoked context's full residual capability, probed with nothing but what
 * it retained (AK + staged DEK-0 blob) plus the envelope A2 relayed:
 *
 * - `hasLocalDek0` / `serverBlobOpens` — the epoch pin. The retained AK must
 *   open the LOCAL staged DEK-0 blob (proving the derivation input survived)
 *   and must FAIL on the post-rotation SERVER copy (proving the rotation really
 *   re-wrapped the keyring under an AK this device was denied). Without the pin
 *   the exploit-arm failure below could not be told apart from "revocation
 *   never happened".
 * - `canaryDecryptsUnderDek0` — the OLD attack verbatim: AES-GCM decrypt of the
 *   canary under DEK-0 with the legacy `canaryAAD(userId, '0')`. Must fail:
 *   the canary is no longer DEK-0-anchored.
 */
const probeRevokedResidual = async (
  page: import('@playwright/test').Page,
  envelope: { iv: string; ctext: string },
  legacyAad: number[],
  wrapAad: number[],
  serverWrappedDek0: string,
): Promise<{ hasLocalDek0: boolean; serverBlobOpens: boolean; canaryDecryptsUnderDek0: boolean }> =>
  page.evaluate(
    async ({ iv, ctext, legacyAad, wrapAad, serverWrappedDek0 }) => {
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
        return { hasLocalDek0: Boolean(wrappedDek0), serverBlobOpens: false, canaryDecryptsUnderDek0: false }
      }

      // The DEK wrap format since THU-893: base64(iv(12) ‖ AES-GCM(raw DEK))
      // with `dekWrapAAD(keyId)` bound as AAD — mirrored here byte-for-byte
      // because a revoked client is exactly as capable of following the format
      // as a trusted one.
      const unwrapDek0 = async (blobBase64: string): Promise<CryptoKey> => {
        const blob = fromBase64(blobBase64)
        return crypto.subtle.unwrapKey(
          'raw',
          blob.slice(12),
          ak,
          { name: 'AES-GCM', iv: blob.slice(0, 12), additionalData: new Uint8Array(wrapAad) },
          { name: 'AES-GCM', length: 256 },
          false,
          ['decrypt'],
        )
      }

      const serverBlobOpens = await unwrapDek0(serverWrappedDek0).then(
        () => true,
        () => false,
      )

      const canaryDecryptsUnderDek0 = await unwrapDek0(wrappedDek0)
        .then((dek0) =>
          crypto.subtle.decrypt(
            { name: 'AES-GCM', iv: fromBase64(iv), additionalData: new Uint8Array(legacyAad) },
            dek0,
            fromBase64(ctext),
          ),
        )
        .then(
          () => true,
          () => false,
        )

      return { hasLocalDek0: true, serverBlobOpens, canaryDecryptsUnderDek0 }
    },
    { iv: envelope.iv, ctext: envelope.ctext, legacyAad, wrapAad, serverWrappedDek0 },
  )

test.describe.serial('THU-872 — revoked device re-derives the current signing key', () => {
  test('a revoked device cannot derive the signing key the account uses after rotation', async ({ browser, page }) => {
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

      // The old attack's derivation input survives in the revoked context —
      // retaining it must no longer matter.
      expect(await getEncryptionKeyNames(victim.page)).toEqual(
        expect.arrayContaining(['thunderbolt_ak', 'thunderbolt_dek_0']),
      )

      // A2 relays the post-rotation canary envelope out of the row it owns. No
      // route, no session — `revokeDeviceSessions` already deleted A4's session.
      const envelope = await getCanaryCiphertext(userId)
      const akAad = [...canaryAAD(userId, akCanaryAnchor)]

      // POSITIVE CONTROL first: the trusted device that ran the revocation holds
      // the NEW AK, and the same blob must open for it — otherwise the failures
      // below prove nothing (a corrupt canary fails for everyone).
      expect(await canaryOpensInContext(page, envelope, akAad)).toBe(true)

      const residual = await probeRevokedResidual(
        victim.page,
        envelope,
        [...canaryAAD(userId, '0')],
        [...dekWrapAAD('0')],
        after.wrappedKeys['0'],
      )

      // Epoch pin: the rotation re-wrapped DEK-0 under the new AK, so the
      // victim's retained AK must FAIL on the post-rotation server copy while
      // its own staged blob opens — it really was locked out, and the exploit
      // arm below fails because of the fix, not a failed harness.
      expect(residual.hasLocalDek0).toBe(true)
      expect(residual.serverBlobOpens).toBe(false)

      // SECURE assertions. The signing key derives from the canary seed, so
      // "cannot derive the live signing key" reduces to "cannot open the current
      // canary" — and the revoked device cannot, by either door:
      // (1) the old attack verbatim — DEK-0 decrypt under the legacy AAD;
      expect(residual.canaryDecryptsUnderDek0).toBe(false)
      // (2) the AK-anchored unwrap with its retained (pre-rotation) AK.
      expect(await canaryOpensInContext(victim.page, envelope, akAad)).toBe(false)
    } finally {
      await victim.context.close()
    }
  })
})
