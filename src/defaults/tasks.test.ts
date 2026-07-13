/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, test } from 'bun:test'
import { defaultTasks, defaultTasksVersion, hashTask } from './tasks'

/**
 * Snapshot pinning the shipped defaults to their declared version. When you
 * change any default task (add/remove/edit/reorder), this test fails.
 *
 * Fix it in this order:
 *   1. Bump `defaultTasksVersion` in `src/defaults/tasks.ts`.
 *   2. Update `expected` below to match the actual values from the failure.
 *
 * The version is the ordering signal reconcile uses to decide who owns the
 * newest defaults across devices (THU-637 pattern extended to tasks in
 * THU-677). Changing defaults without bumping the version breaks that
 * ordering silently.
 */
const computeSnapshotHash = () => defaultTasks.map((task, index) => `${index}:${task.id}:${hashTask(task)}`).join('|')

const expected = {
  version: 1,
  hash: '0:0198ecc5-cc2b-735b-b478-93f8db7202ce:ewc0es|1:0198ecc5-cc2b-735b-b478-96071aa92f62:-9v5tnk|2:0198ecc5-cc2b-735b-b478-99e9874d61ba:-akftt5',
}

describe('defaultTasks version snapshot', () => {
  test('version and content are in sync — read the file header if this fails', () => {
    expect({
      version: defaultTasksVersion,
      hash: computeSnapshotHash(),
    }).toEqual(expected)
  })
})
