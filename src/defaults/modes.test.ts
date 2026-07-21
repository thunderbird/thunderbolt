/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, test } from 'bun:test'
import { defaultModes, defaultModesVersion, hashMode } from './modes'

/**
 * Snapshot pinning the shipped defaults to their declared version. When you
 * change any default mode (add/remove/edit/reorder), this test fails.
 *
 * Fix it in this order:
 *   1. Bump `defaultModesVersion` in `src/defaults/modes.ts`.
 *   2. Update `expected` below to match the actual values from the failure.
 *
 * The version is the ordering signal reconcile uses to decide who owns the
 * newest defaults across devices (THU-637 pattern extended to modes in
 * THU-677). Changing defaults without bumping the version breaks that
 * ordering silently.
 */
const computeSnapshotHash = () => defaultModes.map((mode, index) => `${index}:${mode.id}:${hashMode(mode)}`).join('|')

const expected = {
  version: 1,
  hash: '0:mode-chat:-12w2hw|1:mode-search:-9p223q|2:mode-research:-8fvmwl',
}

describe('defaultModes version snapshot', () => {
  test('version and content are in sync — read the file header if this fails', () => {
    expect({
      version: defaultModesVersion,
      hash: computeSnapshotHash(),
    }).toEqual(expected)
  })
})
