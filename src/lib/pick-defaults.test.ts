/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, test } from 'bun:test'
import { defaultModelOpus48, defaultModels, defaultModelsVersion } from '@shared/defaults/models'
import { pickModelsDefaults } from './pick-defaults'

const serverPayload = (version: number) => ({
  version,
  data: [{ ...defaultModelOpus48, name: `Server v${version}` }],
})

describe('pickModelsDefaults', () => {
  test('bundle wins when server is absent (offline / no fetch yet)', () => {
    const picked = pickModelsDefaults(undefined)
    expect(picked.version).toBe(defaultModelsVersion)
    expect(picked.data).toBe(defaultModels)
  })

  test('server wins when it declares a strictly higher version', () => {
    const server = serverPayload(defaultModelsVersion + 1)
    const picked = pickModelsDefaults(server)
    expect(picked.version).toBe(server.version)
    expect(picked.data).toBe(server.data)
  })

  test('bundle wins when server declares an equal version (avoid needless swap)', () => {
    const picked = pickModelsDefaults(serverPayload(defaultModelsVersion))
    expect(picked.version).toBe(defaultModelsVersion)
    expect(picked.data).toBe(defaultModels)
  })

  test('bundle wins when server declares a lower version (rollback protection)', () => {
    const picked = pickModelsDefaults(serverPayload(defaultModelsVersion - 1))
    expect(picked.version).toBe(defaultModelsVersion)
    expect(picked.data).toBe(defaultModels)
  })

  test('bundle wins when server ships a bumped version with empty data (malformed payload)', () => {
    // Otherwise cleanupRemovedDefaults would soft-delete every unedited system
    // model against an empty currentModelIds set.
    const picked = pickModelsDefaults({ version: defaultModelsVersion + 5, data: [] })
    expect(picked.version).toBe(defaultModelsVersion)
    expect(picked.data).toBe(defaultModels)
  })

  test('bundle wins when server ships a bumped version with a non-array data value', () => {
    // Runtime defense against a malformed JSON response the type system can't catch.
    const picked = pickModelsDefaults({
      version: defaultModelsVersion + 5,
      data: null as unknown as (typeof defaultModels)[number][],
    })
    expect(picked.version).toBe(defaultModelsVersion)
    expect(picked.data).toBe(defaultModels)
  })

  test('bundle wins when server ships a non-finite version (NaN / Infinity)', () => {
    // A "bumped" version that isn't a real number is malformed — treating NaN as
    // higher than the bundle would let bad server responses win.
    for (const version of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      const picked = pickModelsDefaults(serverPayload(version))
      expect(picked.version).toBe(defaultModelsVersion)
      expect(picked.data).toBe(defaultModels)
    }
  })

  test('bundle wins when server payload has zero overlap with bundled ids (wholesale replacement)', () => {
    // Without this guard, `cleanupRemovedDefaults` would treat every bundle-
    // known row as retired (nothing matches server's currentModelIds) and
    // soft-delete them all, while the filtered reconcile pass would insert
    // nothing (OTA-only-new ids have no bundled profile). Client would boot
    // with zero system models.
    const disjointPayload = {
      version: defaultModelsVersion + 5,
      data: [
        { ...defaultModelOpus48, id: 'disjoint-id-1', name: 'Fully Different Model 1' },
        { ...defaultModelOpus48, id: 'disjoint-id-2', name: 'Fully Different Model 2' },
      ],
    }
    const picked = pickModelsDefaults(disjointPayload)
    expect(picked.version).toBe(defaultModelsVersion)
    expect(picked.data).toBe(defaultModels)
  })

  test('server wins when the payload has any overlap with bundled ids (partial overlap ok)', () => {
    // One overlapping id is enough to signal a non-pathological payload —
    // retirement of some bundle ids via partial payload is a legitimate OTA
    // use case and should still work.
    const partialOverlap = {
      version: defaultModelsVersion + 1,
      data: [
        defaultModelOpus48, // in bundle
        { ...defaultModelOpus48, id: 'new-id', name: 'Server-only New Model' },
      ],
    }
    const picked = pickModelsDefaults(partialOverlap)
    expect(picked.version).toBe(defaultModelsVersion + 1)
    expect(picked.data).toBe(partialOverlap.data)
  })
})
