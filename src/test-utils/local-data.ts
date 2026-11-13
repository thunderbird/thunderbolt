/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { bindLocalData, openLocalData, resetLocalDataOwnerForTests } from '@/lib/local-data-owner'

/** The `localStorage` key of the ownership record, which names each slot's owner. */
export const localDataKey = 'thunderbolt_local_data'

/** The stored ownership record, parsed, or null when there is none. */
export const readLocalDataRecord = () => JSON.parse(localStorage.getItem(localDataKey) ?? 'null')

/**
 * Open a new slot, as boot does, so code that asks which account owns the open slot gets an
 * answer. With `owner`, that account claims the slot, as its session would. Call
 * {@link closeTestLocalData} afterwards.
 */
export const openTestLocalData = async (owner?: string): Promise<void> => {
  closeTestLocalData()
  await openLocalData()
  if (owner) {
    bindLocalData(owner)
  }
}

/** Forget the slot {@link openTestLocalData} opened, so the next test starts without one. */
export const closeTestLocalData = (): void => {
  resetLocalDataOwnerForTests()
  localStorage.removeItem(localDataKey)
}
