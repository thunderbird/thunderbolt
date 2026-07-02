/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Tests for persistent node identity. The security-critical properties are:
 * the NodeId is *stable across runs* (what makes an allowlist meaningful), the
 * returned NodeId is genuinely derived from the returned secret bytes, and the
 * private-key file self-heals to 0600. Real native key + real temp home.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { SecretKey } from '@number0/iroh'
import { appendFile, chmod, mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadOrCreateIdentity } from './identity.ts'
import { identityPath, irohDir } from './paths.ts'

let home: string
const prevHome = process.env.THUNDERBOLT_HOME

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'tb-identity-'))
  process.env.THUNDERBOLT_HOME = home
})

afterEach(async () => {
  if (prevHome === undefined) delete process.env.THUNDERBOLT_HOME
  else process.env.THUNDERBOLT_HOME = prevHome
  await rm(home, { recursive: true, force: true })
})

const modeOf = async (path: string): Promise<number> => (await stat(path)).mode & 0o777

describe('loadOrCreateIdentity', () => {
  it('derives the returned NodeId from the returned secret bytes', async () => {
    const { secretKeyBytes, nodeId } = await loadOrCreateIdentity()
    const expected = SecretKey.fromBytes([...secretKeyBytes]).public().toString()
    expect(nodeId).toBe(expected)
  })

  it('persists a stable NodeId across calls (the allowlist depends on this)', async () => {
    const first = await loadOrCreateIdentity()
    const second = await loadOrCreateIdentity()
    expect(second.nodeId).toBe(first.nodeId)
    expect([...second.secretKeyBytes]).toEqual([...first.secretKeyBytes])
  })

  it('writes the private-key file owner-only (0600)', async () => {
    await loadOrCreateIdentity()
    expect(await modeOf(identityPath())).toBe(0o600)
  })

  it('self-heals a key restored with lax permissions back to 0600', async () => {
    const { nodeId } = await loadOrCreateIdentity()
    await chmod(identityPath(), 0o644)
    expect(await modeOf(identityPath())).toBe(0o644)
    const reloaded = await loadOrCreateIdentity()
    expect(reloaded.nodeId).toBe(nodeId)
    expect(await modeOf(identityPath())).toBe(0o600)
  })

  it('tolerates trailing whitespace in the stored hex (trims before decoding)', async () => {
    const { nodeId } = await loadOrCreateIdentity()
    await appendFile(identityPath(), '\n')
    const reloaded = await loadOrCreateIdentity()
    expect(reloaded.nodeId).toBe(nodeId)
  })

  it('surfaces a corrupt (wrong-length) identity file loudly instead of inventing a key', async () => {
    await mkdir(irohDir(), { recursive: true })
    await writeFile(identityPath(), 'deadbeef') // 4 bytes, not the required 32
    await expect(loadOrCreateIdentity()).rejects.toThrow(/32 bytes/)
  })
})
