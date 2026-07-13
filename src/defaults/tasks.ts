/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { hashValues } from '@/lib/utils'
import type { Task } from '@/types'

/**
 * Compute hash of user-editable fields for a task
 * Includes item text and isComplete status - both are user modifications
 * Order is excluded as it's purely for display positioning
 */
export const hashTask = (task: Task): string => {
  return hashValues([task.item, task.isComplete])
}

/**
 * Default tasks shipped with the application
 * These are upserted on app start and serve as the baseline for diff comparisons
 */
export const defaultTaskConnectEmail: Task = {
  id: '0198ecc5-cc2b-735b-b478-93f8db7202ce',
  item: 'Connect your email account to get started',
  order: 100,
  isComplete: 0,
  defaultHash: null,
  deletedAt: null,
  userId: null,
}

export const defaultTaskSetPreferences: Task = {
  id: '0198ecc5-cc2b-735b-b478-96071aa92f62',
  item: 'Set your name and location in preferences for better AI responses',
  order: 200,
  isComplete: 0,
  defaultHash: null,
  deletedAt: null,
  userId: null,
}

export const defaultTaskExplorePro: Task = {
  id: '0198ecc5-cc2b-735b-b478-99e9874d61ba',
  item: 'Explore Thunderbolt Pro tools to extend capabilities',
  order: 300,
  isComplete: 0,
  defaultHash: null,
  deletedAt: null,
  userId: null,
}

/**
 * Array of all default tasks for iteration
 */
export const defaultTasks: ReadonlyArray<Task> = [
  defaultTaskConnectEmail,
  defaultTaskSetPreferences,
  defaultTaskExplorePro,
] as const

/**
 * Monotonic version of the shipped task defaults. Bump every time `defaultTasks`
 * changes in any way. Reconcile uses this as the ordering signal so multi-device
 * sync groups converge without ping-ponging (THU-637 pattern extended to tasks
 * in THU-677): a device only overwrites existing rows when its picked defaults
 * version is strictly newer than the highest ever applied on this account.
 *
 * The paired snapshot test in `tasks.test.ts` fails on any change to this
 * file's defaults without a matching version bump.
 */
export const defaultTasksVersion = 1
