/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { RouterOptions } from 'tinfoil'
import type { TinfoilVerification } from '@/attestation/tinfoil'

/** Supply public verification facts without mocking the SDK's encrypted transport or private state. */
export const testTinfoilVerification = (
  hpkePublicKey = '11'.repeat(32),
  overrides: Partial<TinfoilVerification> = {},
): TinfoilVerification => {
  const value = {
    hpkePublicKey,
    tlsPublicKeyFP: '22'.repeat(32),
    codeDigest: 'aa'.repeat(32),
    codeTag: 'test-release',
    configRepo: 'tinfoilsh/confidential-inference-proxy',
    enclaveMeasurement: { platform: 'sev-snp' as const, launch: new Uint8Array(48).fill(1) },
    codeMeasurement: { platform: 'sev-snp' as const, launch: new Uint8Array(48).fill(1) },
    cryptoMaterial: [
      { id: 'hpke', format: 'https://tinfoil.sh/key/x25519-hpke/v1', data: hpkePublicKey },
      { id: 'tls', format: 'https://tinfoil.sh/key/spki-fp-sha256/v1', data: '22'.repeat(32) },
    ],
    metadata: { verifiedAt: new Date(), verifier: { name: 'test-verifier', version: '2.0.0' } },
    freshnessExpiresAt: new Date(Date.now() + 60_000),
    ...overrides,
  }
  return {
    ...value,
    cryptoMaterialData: () => hpkePublicKey,
    toJSON: () => ({
      codeDigest: value.codeDigest,
      codeTag: value.codeTag,
      configRepo: value.configRepo,
      enclaveMeasurement: { platform: 'sev-snp', launch: '01'.repeat(48) },
      codeMeasurement: { platform: 'sev-snp', launch: '01'.repeat(48) },
      cryptoMaterial: value.cryptoMaterial,
      metadata: { ...value.metadata, verifiedAt: value.metadata.verifiedAt.toISOString() },
      freshnessExpiresAt: value.freshnessExpiresAt.toISOString(),
    }),
  } as TinfoilVerification
}

/** Inject only the public verifier interface; the SDK still validates/binds keys and sends real EHBP. */
export const testTinfoilVerifier = (
  verify: () => Promise<TinfoilVerification>,
): NonNullable<RouterOptions['verifier']> =>
  ({ checkRepoVerifiability: () => {}, verifyV3At: verify }) as unknown as NonNullable<RouterOptions['verifier']>
