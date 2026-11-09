/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { desc } from 'drizzle-orm'
import type { AnyDrizzleDatabase } from '../db/database-interface'
import { receivedSharesTable, sentSharesTable } from '../db/tables'

/** Chats shared with this account, most recently shared first. */
export const getReceivedShares = (db: AnyDrizzleDatabase) =>
  db.select().from(receivedSharesTable).orderBy(desc(receivedSharesTable.updatedAt), desc(receivedSharesTable.id))

/** Chats this account shared, most recently shared first. */
export const getSentShares = (db: AnyDrizzleDatabase) =>
  db.select().from(sentSharesTable).orderBy(desc(sentSharesTable.updatedAt), desc(sentSharesTable.id))
