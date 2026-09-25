/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, test } from 'bun:test'
import { hashValues } from '../lib/hash'
import {
  defaultModelGlm53,
  defaultModelGlm53Flash,
  defaultModelId,
  defaultModelImageSupport,
  defaultModelOpus5,
  defaultModels,
  defaultModelsVersion,
  hashModel,
  type ImageSupportModel,
  staticImageSupport,
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
 * newest defaults across devices. Changing defaults without bumping
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
  version: 9,
  hash: '0:019af08a-c27b-7074-8aac-95315d1ef3fd:-lo3iv3|1:01a06dd7-67ee-75be-b957-2b746271c49d:-n92e4|2:019e7580-2b0e-719c-a43f-d2b56e7f31b4:-mx717t',
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
      contextWindow: 1_000_000,
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

  test('declares image support for every shipped default (the CLI can’t detect it)', () => {
    for (const model of defaultModels) {
      expect({ model: model.model, support: defaultModelImageSupport[model.id] }).toEqual({
        model: model.model,
        support: expect.stringMatching(/^(supported|unsupported)$/),
      })
    }
  })
})

describe('staticImageSupport', () => {
  const model = (overrides: Partial<ImageSupportModel>): ImageSupportModel => ({
    provider: 'custom',
    model: 'llava',
    url: 'http://localhost:11434/v1',
    vendor: null,
    ...overrides,
  })

  test('answers for the shipped defaults from their declarations', () => {
    expect(staticImageSupport(defaultModelOpus5)).toBe('supported')
    expect(staticImageSupport(defaultModelGlm53Flash)).toBe('supported')
    expect(staticImageSupport(defaultModelGlm53)).toBe('unsupported')
  })

  test('applies a default’s declaration to any row on the same provider and model', () => {
    // A user-added Tinfoil row (personal key, no vendor) serving the same upstream model.
    expect(staticImageSupport(model({ provider: 'tinfoil', model: 'glm-5-3', url: null }))).toBe('unsupported')
  })

  test('treats every native Anthropic model as reading images', () => {
    expect(staticImageSupport(model({ provider: 'anthropic', model: 'claude-sonnet-5', url: null }))).toBe('supported')
  })

  test('treats other Thunderbolt-hosted models from vision vendors as reading images', () => {
    expect(staticImageSupport(model({ provider: 'thunderbolt', model: 'gpt-5', vendor: 'openai' }))).toBe('supported')
  })

  test('leaves everything else to detection', () => {
    expect(staticImageSupport(model({}))).toBeUndefined()
    expect(staticImageSupport(model({ provider: 'thunderbolt', model: 'glm', vendor: 'zhipu' }))).toBeUndefined()
    // A vendor only vouches for models Thunderbolt hosts; Tinfoil serves text-only models from vision vendors.
    expect(staticImageSupport(model({ provider: 'tinfoil', model: 'gpt-oss-120b', vendor: 'openai' }))).toBeUndefined()
  })
})
