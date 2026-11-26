/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { spyOn } from 'bun:test'
import type { AnyDrizzleDatabase } from '@/db/database-interface'

/** Match PowerSync's transaction contract in SQLite tests; restore with mock.restore(). */
export const rejectNestedTransactions = (db: AnyDrizzleDatabase) => {
  const transaction = db.transaction.bind(db)
  spyOn(db, 'transaction').mockImplementation((work, config) =>
    transaction(async (tx) => {
      Object.defineProperty(tx, 'transaction', {
        value: () => {
          throw new Error('Nested transactions are not supported')
        },
      })
      return work(tx)
    }, config),
  )
}
