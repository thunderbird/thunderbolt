/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { existsSync } from 'fs'
import { resolve } from 'path'
import { getMigrationsFolder } from './client'

describe('getMigrationsFolder', () => {
  let originalMigrationsDir: string | undefined

  beforeEach(() => {
    originalMigrationsDir = process.env.MIGRATIONS_DIR
    delete process.env.MIGRATIONS_DIR
  })

  afterEach(() => {
    if (originalMigrationsDir === undefined) {
      delete process.env.MIGRATIONS_DIR
    } else {
      process.env.MIGRATIONS_DIR = originalMigrationsDir
    }
  })

  it('returns MIGRATIONS_DIR env var when set', () => {
    process.env.MIGRATIONS_DIR = '/custom/migrations'
    expect(getMigrationsFolder()).toBe('/custom/migrations')
  })

  it('falls back to resolve(cwd, "drizzle") when MIGRATIONS_DIR is not set', () => {
    expect(getMigrationsFolder()).toBe(resolve(process.cwd(), 'drizzle'))
  })

  it('resolves to a directory that contains migration files when run from backend/', () => {
    const folder = getMigrationsFolder()
    expect(existsSync(folder)).toBe(true)
    expect(existsSync(resolve(folder, 'meta'))).toBe(true)
  })
})
