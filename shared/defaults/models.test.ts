/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, test } from 'bun:test'
import { defaultModels, defaultModelsVersion, hashModel } from './models'

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

const expected = {
  version: 2,
  hash: '0:019af08a-c27b-7074-8aac-95315d1ef3fd:-1vf2pk|1:019f227e-d640-727d-ba12-d51bd7d0a3d6:bvaax2|2:019e7580-2b0e-719c-a43f-d2b56e7f31b4:-g7x2jr',
}

describe('defaultModels version snapshot', () => {
  test('version and content are in sync — read the file header if this fails', () => {
    expect({
      version: defaultModelsVersion,
      hash: computeSnapshotHash(),
    }).toEqual(expected)
  })
})
