/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * C10 — key material at rest. **Claim holds.**
 *
 * C10: key material is non-extractable where it must be, the ML-KEM secret is
 * encrypted at rest, and sign-out leaves no orphaned key. This spec is the
 * at-rest witness — it reads the `thunderbolt-keys` IndexedDB the app actually
 * writes and asserts:
 *   - the Account Key (`thunderbolt_ak`) is a CryptoKey with `extractable === false`
 *     and `exportKey` rejects — so a same-origin script (A6) or a device-image
 *     thief can USE it but never lift its raw bytes;
 *   - the device ECDH private key is likewise non-extractable and unexportable;
 *   - the ML-KEM secret is stored as `{ iv, ciphertext }` (encrypted at rest,
 *     THU-427), never as raw plaintext bytes.
 *
 * (Sign-out clearing keys is covered by `persistence.spec.ts`; this file covers
 * the non-extractability half C10 also claims.)
 *
 * Requires the PowerSync + Postgres harness. Run with:
 *   bash scripts/run-e2ee-powersync.sh attacks/key-material-at-rest.spec.ts
 */

import { expect, test } from '../fixtures'
import { waitForUserId } from '../db'
import { completeFirstDeviceSetup, createE2eeEmail, loginViaConsumerOtp } from '../helpers'

type KeyProbe = { isCryptoKey: boolean; extractable: boolean | null; exportRejected: boolean }
type AtRestReport = {
  ak: KeyProbe
  ecdhPrivateKey: KeyProbe
  mlkemSecretIsRawBytes: boolean
  mlkemSecretIsEncryptedEnvelope: boolean
}

test.describe.serial('C10 — key material at rest', () => {
  test('the AK and device private key are non-extractable; the ML-KEM secret is encrypted at rest', async ({
    page,
  }) => {
    const email = createE2eeEmail()
    await loginViaConsumerOtp(page, email)
    await waitForUserId(email)
    await completeFirstDeviceSetup(page)

    const report = await page.evaluate<AtRestReport>(async () => {
      const openDb = () =>
        new Promise<IDBDatabase>((resolve, reject) => {
          const request = indexedDB.open('thunderbolt-keys')
          request.onsuccess = () => resolve(request.result)
          request.onerror = () => reject(request.error)
        })
      const readEntry = (db: IDBDatabase, id: string) =>
        new Promise<unknown>((resolve, reject) => {
          const request = db.transaction('keys', 'readonly').objectStore('keys').get(id)
          request.onsuccess = () => resolve(request.result ?? null)
          request.onerror = () => reject(request.error)
        })

      const probe = async (value: unknown, format: 'raw' | 'pkcs8'): Promise<KeyProbe> => {
        if (!(value instanceof CryptoKey)) {
          return { isCryptoKey: false, extractable: null, exportRejected: false }
        }
        let exportRejected = false
        try {
          await crypto.subtle.exportKey(format, value)
        } catch {
          exportRejected = true
        }
        return { isCryptoKey: true, extractable: value.extractable, exportRejected }
      }

      const db = await openDb()
      const ak = await readEntry(db, 'thunderbolt_ak')
      const ecdhPrivateKey = await readEntry(db, 'thunderbolt_private_key')
      const mlkemSecret = await readEntry(db, 'thunderbolt_mlkem_secret_key')
      db.close()

      const isRawBytes = mlkemSecret instanceof Uint8Array
      const isEnvelope =
        !!mlkemSecret &&
        typeof mlkemSecret === 'object' &&
        !isRawBytes &&
        'iv' in (mlkemSecret as Record<string, unknown>) &&
        'ciphertext' in (mlkemSecret as Record<string, unknown>)

      return {
        ak: await probe(ak, 'raw'),
        ecdhPrivateKey: await probe(ecdhPrivateKey, 'pkcs8'),
        mlkemSecretIsRawBytes: isRawBytes,
        mlkemSecretIsEncryptedEnvelope: isEnvelope,
      }
    })

    // The AK is a non-extractable CryptoKey and its raw bytes cannot be lifted.
    expect(report.ak.isCryptoKey).toBe(true)
    expect(report.ak.extractable).toBe(false)
    expect(report.ak.exportRejected).toBe(true)

    // The device ECDH private key is non-extractable and unexportable too.
    expect(report.ecdhPrivateKey.isCryptoKey).toBe(true)
    expect(report.ecdhPrivateKey.extractable).toBe(false)
    expect(report.ecdhPrivateKey.exportRejected).toBe(true)

    // The ML-KEM secret is encrypted at rest, never stored as raw plaintext.
    expect(report.mlkemSecretIsRawBytes).toBe(false)
    expect(report.mlkemSecretIsEncryptedEnvelope).toBe(true)
  })
})
