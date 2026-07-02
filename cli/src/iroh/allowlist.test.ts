/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Tests for the peer allowlist — the authorization gate for the iroh transport.
 * Uses a real temp `THUNDERBOLT_HOME` (DI-over-mocking: the file store is the
 * unit under test, so we exercise it against a real, isolated filesystem rather
 * than a mocked fs).
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtemp, rm, stat, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { add, isAllowed, list } from './allowlist.ts'
import { allowlistPath, irohDir } from './paths.ts'

let home: string
const prevHome = process.env.THUNDERBOLT_HOME

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'tb-allowlist-'))
  process.env.THUNDERBOLT_HOME = home
})

afterEach(async () => {
  if (prevHome === undefined) delete process.env.THUNDERBOLT_HOME
  else process.env.THUNDERBOLT_HOME = prevHome
  await rm(home, { recursive: true, force: true })
})

/** Write a raw allowlist file (bypassing `add`) to test parsing of arbitrary content. */
const writeRawAllowlist = async (contents: string): Promise<void> => {
  await mkdir(irohDir(), { recursive: true })
  await writeFile(allowlistPath(), contents)
}

describe('list', () => {
  it('is empty when no allowlist file exists (no peer trusted by default)', async () => {
    expect(await list()).toEqual([])
  })

  it('trims, drops blank lines, and de-duplicates', async () => {
    await writeRawAllowlist('  peerA  \n\npeerB\n  \npeerA\n')
    expect(await list()).toEqual(['peerA', 'peerB'])
  })
})

describe('isAllowed — the gate', () => {
  it('refuses a non-allowlisted NodeId (empty allowlist => false)', async () => {
    expect(await isAllowed('peerX')).toBe(false)
  })

  it('refuses a NodeId not present even when others are', async () => {
    await add('peerA')
    expect(await isAllowed('peerB')).toBe(false)
  })

  it('permits an allowlisted NodeId', async () => {
    await add('peerA')
    expect(await isAllowed('peerA')).toBe(true)
  })

  it('trims the queried NodeId before matching', async () => {
    await add('peerA')
    expect(await isAllowed('  peerA  ')).toBe(true)
  })

  it('does not match on a substring / prefix (exact NodeId only)', async () => {
    await add('peerAardvark')
    expect(await isAllowed('peerA')).toBe(false)
  })
})

describe('add', () => {
  it('returns true when newly added and false on a duplicate (idempotent)', async () => {
    expect(await add('peerA')).toBe(true)
    expect(await add('peerA')).toBe(false)
    expect(await list()).toEqual(['peerA'])
  })

  it('trims before storing, so a padded duplicate is detected', async () => {
    expect(await add('  peerA  ')).toBe(true)
    expect(await list()).toEqual(['peerA'])
    expect(await add('peerA')).toBe(false)
  })

  it('appends additional NodeIds in order', async () => {
    await add('peerA')
    await add('peerB')
    expect(await list()).toEqual(['peerA', 'peerB'])
    expect(await isAllowed('peerA')).toBe(true)
    expect(await isAllowed('peerB')).toBe(true)
  })

  it('a blank input never becomes a usable (trusted) empty entry', async () => {
    await add('   ')
    // The blank trims away on read, so no empty NodeId can ever be "allowed".
    expect(await list()).toEqual([])
    expect(await isAllowed('')).toBe(false)
    expect(await isAllowed('   ')).toBe(false)
  })

  it('persists the allowlist through the secure store (0600 file in a 0700 dir)', async () => {
    await add('peerA')
    expect((await stat(allowlistPath())).mode & 0o777).toBe(0o600)
    expect((await stat(irohDir())).mode & 0o777).toBe(0o700)
  })
})
