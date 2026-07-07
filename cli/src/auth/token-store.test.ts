/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Round-trip + permission coverage for the CLI credential store, exercised
 * against a real isolated `THUNDERBOLT_HOME` (DI-over-mocking: the file store is
 * the unit, so it runs on a real temp filesystem rather than a mocked fs).
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadAuthConfig, storeAuthConfig } from './token-store.ts'

let home: string
const prevHome = process.env.THUNDERBOLT_HOME

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'tb-auth-'))
  process.env.THUNDERBOLT_HOME = home
})

afterEach(async () => {
  if (prevHome === undefined) delete process.env.THUNDERBOLT_HOME
  else process.env.THUNDERBOLT_HOME = prevHome
  await rm(home, { recursive: true, force: true })
})

describe('token store', () => {
  it('returns null before any login', async () => {
    expect(await loadAuthConfig()).toBeNull()
  })

  it('round-trips the stored credential', async () => {
    await storeAuthConfig({ token: 'signed.jwt', cloudUrl: 'https://api.test/v1' })
    expect(await loadAuthConfig()).toEqual({ token: 'signed.jwt', cloudUrl: 'https://api.test/v1' })
  })

  it('overwrites a prior login', async () => {
    await storeAuthConfig({ token: 'first', cloudUrl: 'https://a/v1' })
    await storeAuthConfig({ token: 'second', cloudUrl: 'https://b/v1' })
    expect(await loadAuthConfig()).toEqual({ token: 'second', cloudUrl: 'https://b/v1' })
  })

  it('persists the credential owner-only (0600)', async () => {
    await storeAuthConfig({ token: 'signed.jwt', cloudUrl: 'https://api.test/v1' })
    expect((await stat(join(home, 'auth.json'))).mode & 0o777).toBe(0o600)
  })
})
