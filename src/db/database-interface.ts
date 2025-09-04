import type { BaseSQLiteDatabase } from 'drizzle-orm/sqlite-core'
import type * as schema from './schema'

export interface DatabaseInterface {
  db: BaseSQLiteDatabase<'async', any, typeof schema>
  initialize(path: string): Promise<void>
  close?(): Promise<void>
}

export type AnyDrizzleDatabase = BaseSQLiteDatabase<'async', any, typeof schema>
