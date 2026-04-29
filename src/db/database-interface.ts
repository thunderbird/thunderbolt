/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { BaseSQLiteDatabase } from 'drizzle-orm/sqlite-core'
import type * as schema from './schema'

export type DatabaseInterface = {
  db: BaseSQLiteDatabase<'async', any, typeof schema>
  initialize(path: string): Promise<void>
  close?(): Promise<void>
  /** Wait for initial sync to complete (PowerSync only) */
  waitForInitialSync?(): Promise<void>
}

export type AnyDrizzleDatabase = BaseSQLiteDatabase<'async', any, typeof schema>
