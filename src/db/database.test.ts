/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it, spyOn } from 'bun:test'
import { Database, getCurrentDatabase, resetDatabase, setDatabase } from './database'
import { BunSQLiteDatabase } from './bun-sqlite-database'

describe('database lifecycle ownership', () => {
  it('coalesces concurrent initialization and serializes a following close/reopen', async () => {
    const initialize = spyOn(BunSQLiteDatabase.prototype, 'initialize')
    const database = new Database()
    try {
      const [first, duplicate] = await Promise.all([
        database.initialize({ type: 'bun-sqlite', path: ':memory:' }),
        database.initialize({ type: 'bun-sqlite', path: ':memory:' }),
      ])
      expect(first).toBe(duplicate)
      expect(initialize).toHaveBeenCalledTimes(1)
      const close = database.close()
      const reopened = database.initialize({ type: 'bun-sqlite', path: ':memory:' })
      await close
      expect(await reopened).not.toBe(first)
      expect(initialize).toHaveBeenCalledTimes(2)
    } finally {
      await database.close()
      initialize.mockRestore()
    }
  })

  it('allows retry after a failed initialization', async () => {
    const initialize = spyOn(BunSQLiteDatabase.prototype, 'initialize').mockRejectedValueOnce(new Error('open failed'))
    const close = spyOn(BunSQLiteDatabase.prototype, 'close')
    const database = new Database()
    try {
      await expect(database.initialize({ type: 'bun-sqlite', path: ':memory:' })).rejects.toThrow('open failed')
      await database.initialize({ type: 'bun-sqlite', path: ':memory:' })
      expect(database.isInitialized).toBe(true)
      expect(close).toHaveBeenCalledTimes(1)
    } finally {
      await database.close()
      initialize.mockRestore()
      close.mockRestore()
    }
  })

  it('keeps a failed close unavailable and retires its resource before reopening', async () => {
    const database = new Database()
    await database.initialize({ type: 'bun-sqlite', path: ':memory:' })
    const close = spyOn(BunSQLiteDatabase.prototype, 'close').mockRejectedValueOnce(new Error('close failed'))
    try {
      await expect(database.close()).rejects.toThrow('close failed')
      expect(database.isInitialized).toBe(false)
      expect(() => database.db).toThrow('Database not initialized')
      expect(() => database.database).toThrow('Database not initialized')
      await database.initialize({ type: 'bun-sqlite', path: ':memory:' })
      expect(close).toHaveBeenCalledTimes(2)
      expect(database.isInitialized).toBe(true)
    } finally {
      await database.close()
      close.mockRestore()
    }
  })

  it('never unregisters a replacement instance when an older reset finishes', async () => {
    const original = getCurrentDatabase()
    const previous = new Database()
    const replacement = new Database()
    const closing = Promise.withResolvers<void>()
    const close = spyOn(previous, 'close').mockImplementation(() => closing.promise)
    try {
      setDatabase(previous)
      const reset = resetDatabase()
      setDatabase(replacement)
      closing.resolve()
      await reset
      expect(getCurrentDatabase()).toBe(replacement)
    } finally {
      close.mockRestore()
      await resetDatabase()
      if (original) {
        setDatabase(original)
      }
    }
  })
})
