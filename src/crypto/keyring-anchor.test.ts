/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, test } from 'bun:test'

import { encodeAAD, initialKeyId } from '@shared/e2ee-types'

import { anchorVersion, keyringAnchorOpens, mintKeyringAnchor } from './keyring-anchor'
import { decrypt, generateDEK } from './primitives'

describe('keyring anchor', () => {
  test('opens under the DEK it was minted from', async () => {
    const dek0 = await generateDEK()
    const anchor = await mintKeyringAnchor(dek0)

    expect(anchor.version).toBe(anchorVersion)
    expect(await keyringAnchorOpens(anchor, dek0)).toBe(true)
  })

  test('does not open under different key material — the whole point', async () => {
    const anchor = await mintKeyringAnchor(await generateDEK())

    expect(await keyringAnchorOpens(anchor, await generateDEK())).toBe(false)
  })

  test('is rejected when its stored format version is superseded', async () => {
    const dek0 = await generateDEK()
    const anchor = await mintKeyringAnchor(dek0)

    // What a device carrying an older on-disk format looks like. It must read as
    // "not current" rather than as "wrong key", so the caller re-mints from
    // local state instead of refusing every future account key.
    expect(await keyringAnchorOpens({ ...anchor, version: anchorVersion - 1 }, dek0)).toBe(false)
  })

  test('uses a fresh IV per mint — a fixed one would be GCM nonce reuse under DEK 0', async () => {
    const dek0 = await generateDEK()

    const ivs = new Set<string>()
    for (let i = 0; i < 8; i++) {
      ivs.add((await mintKeyringAnchor(dek0)).iv)
    }
    expect(ivs.size).toBe(8)
  })

  /**
   * DURABLE ON-DISK FORMAT. This pins the plaintext and the AAD tuple that every
   * already-minted anchor on every user's disk was written with. Changing either
   * without bumping `anchorVersion` would make existing anchors unopenable — and
   * an unopenable anchor is indistinguishable from a substituted account key, so
   * the failure would be a silent, permanent refusal to adopt any AK rather than
   * anything a test or a type would catch.
   *
   * If this fails: bump `anchorVersion` so devices re-mint, then update the
   * expectation. Do not simply update the expectation.
   */
  test('format is pinned: plaintext and AAD tuple', async () => {
    const dek0 = await generateDEK()
    const anchor = await mintKeyringAnchor(dek0)

    expect(anchorVersion).toBe(1)
    const aad = encodeAAD('__meta', 'keyring_anchor', String(anchorVersion), initialKeyId)
    expect(await decrypt({ iv: anchor.iv, ciphertext: anchor.ciphertext }, dek0, aad)).toBe(
      'thunderbolt-keyring-anchor',
    )
  })
})
