/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Tests for persistent node identity. The security-critical properties are:
 * each bridge protocol gets a *distinct* NodeId (so an acp ticket can't
 * authenticate the mcp bridge), the NodeId is *stable across runs* (what makes
 * an allowlist meaningful), the returned NodeId is genuinely derived from the
 * returned secret bytes, and the private-key file self-heals to 0600. The `acp`
 * identity keeps the legacy `identity` filename so existing pairings survive.
 * Real native key + real temp home.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { SecretKey } from '@number0/iroh'
import { appendFile, chmod, mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BridgeProtocol } from '../agent/types.ts'
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

const protocols: BridgeProtocol[] = ['acp', 'mcp']

describe('loadOrCreateIdentity', () => {
  it('gives each protocol a distinct NodeId and distinct secret bytes', async () => {
    const acp = await loadOrCreateIdentity('acp')
    const mcp = await loadOrCreateIdentity('mcp')
    expect(mcp.nodeId).not.toBe(acp.nodeId)
    expect([...mcp.secretKeyBytes]).not.toEqual([...acp.secretKeyBytes])
  })

  for (const protocol of protocols) {
    it(`derives the returned NodeId from the returned secret bytes (${protocol})`, async () => {
      const { secretKeyBytes, nodeId } = await loadOrCreateIdentity(protocol)
      const expected = SecretKey.fromBytes([...secretKeyBytes]).public().toString()
      expect(nodeId).toBe(expected)
    })

    it(`persists a stable NodeId across calls — the allowlist depends on this (${protocol})`, async () => {
      const first = await loadOrCreateIdentity(protocol)
      const second = await loadOrCreateIdentity(protocol)
      expect(second.nodeId).toBe(first.nodeId)
      expect([...second.secretKeyBytes]).toEqual([...first.secretKeyBytes])
    })

    it(`writes the private-key file owner-only, 0600 (${protocol})`, async () => {
      await loadOrCreateIdentity(protocol)
      expect(await modeOf(identityPath(protocol))).toBe(0o600)
    })

    it(`self-heals a key restored with lax permissions back to 0600 (${protocol})`, async () => {
      const { nodeId } = await loadOrCreateIdentity(protocol)
      await chmod(identityPath(protocol), 0o644)
      expect(await modeOf(identityPath(protocol))).toBe(0o644)
      const reloaded = await loadOrCreateIdentity(protocol)
      expect(reloaded.nodeId).toBe(nodeId)
      expect(await modeOf(identityPath(protocol))).toBe(0o600)
    })

    it(`tolerates trailing whitespace in the stored hex — trims before decoding (${protocol})`, async () => {
      const { nodeId } = await loadOrCreateIdentity(protocol)
      await appendFile(identityPath(protocol), '\n')
      const reloaded = await loadOrCreateIdentity(protocol)
      expect(reloaded.nodeId).toBe(nodeId)
    })

    it(`surfaces a corrupt (wrong-length) identity file loudly instead of inventing a key (${protocol})`, async () => {
      await mkdir(irohDir(), { recursive: true })
      await writeFile(identityPath(protocol), 'deadbeef') // 4 bytes, not the required 32
      await expect(loadOrCreateIdentity(protocol)).rejects.toThrow(/32 bytes/)
    })
  }

  it('reads the legacy `identity` file for acp so existing pairings survive, and does NOT reuse it for mcp', async () => {
    const legacySecret = SecretKey.generate().toBytes()
    const legacyNodeId = SecretKey.fromBytes([...legacySecret]).public().toString()
    await mkdir(irohDir(), { recursive: true })
    await writeFile(identityPath('acp'), Buffer.from(legacySecret).toString('hex'))

    const acp = await loadOrCreateIdentity('acp')
    expect(acp.nodeId).toBe(legacyNodeId)

    const mcp = await loadOrCreateIdentity('mcp')
    expect(mcp.nodeId).not.toBe(legacyNodeId)
    expect([...mcp.secretKeyBytes]).not.toEqual([...legacySecret])
  })
})
