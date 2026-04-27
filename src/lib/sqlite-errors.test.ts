/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { isInsertConflictError } from './sqlite-errors'

describe('isInsertConflictError', () => {
  it('returns true for Bun SQLite errno 2067 (UNIQUE)', () => {
    expect(isInsertConflictError({ errno: 2067 })).toBe(true)
  })

  it('returns true for Bun SQLite errno 1555 (PRIMARYKEY)', () => {
    expect(isInsertConflictError({ errno: 1555 })).toBe(true)
  })

  it('returns true for Bun SQLite errno 2579 (ROWID)', () => {
    expect(isInsertConflictError({ errno: 2579 })).toBe(true)
  })

  it('returns true for Bun SQLite code SQLITE_CONSTRAINT_UNIQUE', () => {
    expect(isInsertConflictError({ code: 'SQLITE_CONSTRAINT_UNIQUE' })).toBe(true)
  })

  it('returns true for Bun SQLite code SQLITE_CONSTRAINT_PRIMARYKEY', () => {
    expect(isInsertConflictError({ code: 'SQLITE_CONSTRAINT_PRIMARYKEY' })).toBe(true)
  })

  it('returns true for Bun SQLite code SQLITE_CONSTRAINT_ROWID', () => {
    expect(isInsertConflictError({ code: 'SQLITE_CONSTRAINT_ROWID' })).toBe(true)
  })

  it('returns true for message containing UNIQUE constraint failed', () => {
    expect(isInsertConflictError(new Error('UNIQUE constraint failed: settings.id'))).toBe(true)
  })

  it('returns true for message containing PRIMARY KEY constraint failed', () => {
    expect(isInsertConflictError(new Error('PRIMARY KEY constraint failed: chat_messages.id'))).toBe(true)
  })

  it('returns true for message containing UNIQUE constraint', () => {
    expect(isInsertConflictError(new Error('UNIQUE constraint violated on column foo'))).toBe(true)
  })

  it('returns true for wa-sqlite Unexpected step result format', () => {
    expect(isInsertConflictError(new Error('Unexpected step result: 2067'))).toBe(true)
    expect(isInsertConflictError(new Error('Unexpected step result: 1555'))).toBe(true)
    expect(isInsertConflictError(new Error('Unexpected step result: 2579'))).toBe(true)
  })

  it('returns false for disk full error', () => {
    expect(isInsertConflictError(new Error('disk I/O error: database or disk is full'))).toBe(false)
    expect(isInsertConflictError({ errno: 13 })).toBe(false)
  })

  it('returns false for database corrupt error', () => {
    expect(isInsertConflictError(new Error('database disk image is malformed'))).toBe(false)
    expect(isInsertConflictError({ errno: 11 })).toBe(false)
  })

  it('returns false for NOT NULL constraint (wrong constraint type)', () => {
    expect(isInsertConflictError({ errno: 1299 })).toBe(false)
    expect(isInsertConflictError(new Error('NOT NULL constraint failed: settings.value'))).toBe(false)
  })

  it('returns false for null/undefined', () => {
    expect(isInsertConflictError(null)).toBe(false)
    expect(isInsertConflictError(undefined)).toBe(false)
  })

  it('returns false for wa-sqlite non-conflict step result', () => {
    expect(isInsertConflictError(new Error('Unexpected step result: 19'))).toBe(false)
    expect(isInsertConflictError(new Error('Unexpected step result: 999'))).toBe(false)
  })

  it('returns true when error is wrapped (e.g. DrizzleQueryError) with cause', () => {
    const sqliteError = Object.assign(new Error('UNIQUE constraint failed'), {
      errno: 2067,
      code: 'SQLITE_CONSTRAINT_UNIQUE',
    })
    const wrapped = Object.assign(new Error('Failed query'), { cause: sqliteError })
    expect(isInsertConflictError(wrapped)).toBe(true)
  })
})
