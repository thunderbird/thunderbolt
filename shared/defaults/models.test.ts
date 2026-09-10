/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, test } from 'bun:test'
import { hashValues } from '../lib/hash'
import {
  defaultModelGlm53Flash,
  defaultModelGlm53,
  defaultModelId,
  defaultModelOpus5,
  defaultModels,
  defaultModelsVersion,
  hashModel,
  modelSupportsImages,
} from './models'

/**
 * Snapshot pinning the shipped defaults to their declared version. When you
 * change any default model (add/remove/edit/reorder), this test fails.
 *
 * Fix it in this order:
 *   1. Bump `defaultModelsVersion` in `shared/defaults/models.ts`.
 *   2. Update `expected` below to match the actual values from the failure.
 *
 * The version is the ordering signal reconcile uses to decide who owns the
 * newest defaults across devices (THU-637). Changing defaults without bumping
 * the version breaks that ordering silently.
 */
const computeSnapshotHash = () =>
  defaultModels.map((model, index) => `${index}:${model.id}:${hashModel(model)}`).join('|')

// `hashModel` deliberately hashes only user-editable fields (it drives the
// user-edit detection in reconciliation), so it is blind to metadata like
// `vendor` and `description`. Hash those separately here so a metadata-only
// defaults change still trips the snapshot and gets its version bump.
const computeMetadataHash = () =>
  defaultModels.map((model, index) => `${index}:${hashValues([model.vendor, model.description])}`).join('|')

const expected = {
  version: 6,
  hash: '0:019af08a-c27b-7074-8aac-95315d1ef3fd:n56kdk|1:01a06dd7-67ee-75be-b957-2b746271c49d:-n92e4|2:019e7580-2b0e-719c-a43f-d2b56e7f31b4:-mx717t',
  metadataHash: '0:vzhyk4|1:d17qpa|2:-cajkcl',
}

describe('defaultModels version snapshot', () => {
  test('selects confidential Flash by default', () => {
    expect(defaultModelId).toBe(defaultModelGlm53Flash.id)
  })

  test('preserves the confidential Flash row identity', () => {
    expect(defaultModelGlm53Flash).toMatchObject({
      id: '01a06dd7-67ee-75be-b957-2b746271c49d',
      provider: 'tinfoil',
      model: 'glm-5-3-flash',
      isSystem: 1,
      isConfidential: 1,
      vendor: 'zhipu',
      contextWindow: 131072,
      toolUsage: 1,
      supportsParallelToolCalls: 0,
      startWithReasoning: 0,
    })
    expect(defaultModels.some(({ id }) => id === '019f227e-d640-727d-ba12-d51bd7d0a3d6')).toBe(false)
  })

  test('ships Opus 5 as the sole model using its canonical id', () => {
    expect(defaultModelOpus5).toMatchObject({
      id: '019af08a-c27b-7074-8aac-95315d1ef3fd',
      name: 'Opus 5',
      provider: 'thunderbolt',
      model: 'opus-5',
      contextWindow: 200_000,
      isSystem: 1,
      enabled: 1,
      toolUsage: 1,
      supportsParallelToolCalls: 1,
      isConfidential: 0,
    })
    expect(defaultModels.filter(({ id }) => id === defaultModelOpus5.id)).toEqual([defaultModelOpus5])
  })

  test('version and content are in sync — read the file header if this fails', () => {
    expect({
      version: defaultModelsVersion,
      hash: computeSnapshotHash(),
      metadataHash: computeMetadataHash(),
    }).toEqual(expected)
  })

  test('ships complete public presentation metadata for every managed model', () => {
    for (const model of defaultModels) {
      expect(model.name).not.toBe('')
      expect(model.description).not.toBeNull()
      expect(model.vendor).not.toBeNull()
      expect(model.contextWindow).toBeGreaterThan(0)
    }
  })
})

describe('modelSupportsImages', () => {
  test('supports images for GLM 5.3 Flash but not GLM 5.3', () => {
    expect(modelSupportsImages(defaultModelGlm53Flash)).toBe(true)
    expect(modelSupportsImages(defaultModelGlm53)).toBe(false)
  })

  test('true for known vision vendors', () => {
    expect(modelSupportsImages({ vendor: 'anthropic', model: 'custom' })).toBe(true)
    expect(modelSupportsImages({ vendor: 'openai', model: 'custom' })).toBe(true)
    expect(modelSupportsImages({ vendor: 'google', model: 'custom' })).toBe(true)
  })

  test('false for unknown or absent vendors (no guessing for custom/local)', () => {
    expect(modelSupportsImages({ vendor: null, model: 'custom' })).toBe(false)
    expect(modelSupportsImages({ vendor: 'ollama', model: 'custom' })).toBe(false)
    expect(modelSupportsImages({ vendor: '', model: 'custom' })).toBe(false)
  })
})
