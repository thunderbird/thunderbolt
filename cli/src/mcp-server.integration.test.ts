/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Offline-tolerant integration test: drives the REAL
// @modelcontextprotocol/server-everything child through the OFFICIAL MCP client
// over the real HTTP face, with no mocks. It resolves server-everything locally
// (no network) and SKIPS the whole suite when the dependency is unavailable, so
// CI stays green offline.

import { test, describe, expect, beforeAll, afterAll } from 'bun:test'
import * as path from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { makeLogger } from './log'
import { startMcpFace } from './mcp-server'
import type { FaceHandle } from './types'

/** The subset of a server-everything package.json this resolver reads. */
type ServerEverythingPkg = { bin?: string | Record<string, string>; main?: string }

/**
 * Resolve a launch argv for server-everything from the locally-installed package
 * (no network). Returns null when the dependency isn't installed, so the suite
 * skips rather than failing offline.
 * @returns {string[]|null}
 */
const resolveServerEverythingLaunch = (): string[] | null => {
  try {
    const pkgPath = require.resolve('@modelcontextprotocol/server-everything/package.json')
    const pkg = require(pkgPath) as ServerEverythingPkg
    const dir = path.dirname(pkgPath)
    const binEntry =
      typeof pkg.bin === 'string' ? pkg.bin : (pkg.bin?.['mcp-server-everything'] ?? Object.values(pkg.bin ?? {})[0])
    const bin = binEntry ? path.resolve(dir, binEntry) : path.resolve(dir, pkg.main ?? 'dist/index.js')
    return [process.execPath, bin, 'stdio']
  } catch {
    return null
  }
}

const launch = resolveServerEverythingLaunch()
const unavailable = launch === null

describe.skipIf(unavailable)('mcp-server integration (real server-everything)', () => {
  let face: FaceHandle | null = null
  let client: Client | null = null

  beforeAll(async () => {
    const logger = makeLogger({ json: false, verbose: false, sink: process.stderr })
    face = await startMcpFace({
      launch: launch!,
      host: '127.0.0.1',
      port: 0,
      allowOrigins: [],
      allowAnyOrigin: false,
      logger,
    })
    client = new Client({ name: 'integration-test', version: '0.0.0' })
    const transport = new StreamableHTTPClientTransport(new URL(face!.url))
    await client!.connect(transport)
  })

  afterAll(async () => {
    // Always teardown so no child/socket leaks even on assertion failure.
    if (client) await client!.close().catch(() => {})
    if (face) await face.close()
  })

  test('initialize handshake succeeds through the face', () => {
    expect(client).not.toBeNull()
    expect(client!.getServerVersion()).toBeTruthy()
  })

  test('tools/list returns a non-empty tool set', async () => {
    const { tools } = await client!.listTools()
    expect(Array.isArray(tools)).toBe(true)
    expect(tools.length).toBeGreaterThan(0)
  })

  test('calling the echo tool returns a well-formed result', async () => {
    const { tools } = await client!.listTools()
    const echo = tools.find((t) => t.name === 'echo')
    expect(echo).toBeTruthy()
    const result = await client!.callTool({ name: 'echo', arguments: { message: 'hello bridge' } })
    const text = ((result.content ?? []) as Array<{ text?: string }>).map((c) => c.text ?? '').join('')
    expect(text).toContain('hello bridge')
  })

  // The multiplexing proof: the Thunderbolt app opens several MCP connections
  // (a Test-Connection probe, the persistent provider connection, reconnects).
  // The OLD single-session transport rejected the SECOND initialize with
  // "Server already initialized", killing the live connection. Here TWO clients
  // connect to the SAME face URL sequentially (and a THIRD after the first
  // closes), all sharing the ONE child (initialized exactly once) — every one
  // must initialize, list the full tool set, and round-trip a tool call.
  test('TWO concurrent clients both initialize, list tools, and call echo (multiplexed onto one child)', async () => {
    const open = async (name: string) => {
      const c = new Client({ name, version: '0.0.0' })
      await c.connect(new StreamableHTTPClientTransport(new URL(face!.url)))
      return c
    }

    // The first client (`client`) is already connected from beforeAll. Open a
    // second to the same URL — under the OLD code this initialize was rejected.
    const second = await open('integration-second')
    try {
      expect(client!.getServerVersion()).toBeTruthy()
      expect(second.getServerVersion()).toBeTruthy()

      const first = await client!.listTools()
      const secondList = await second.listTools()
      expect(first.tools).toHaveLength(13)
      expect(secondList.tools).toHaveLength(13)

      const e1 = await client!.callTool({ name: 'echo', arguments: { message: 'from-first' } })
      const e2 = await second.callTool({ name: 'echo', arguments: { message: 'from-second' } })
      expect(((e1.content ?? []) as Array<{ text?: string }>).map((c) => c.text ?? '').join('')).toContain('from-first')
      expect(((e2.content ?? []) as Array<{ text?: string }>).map((c) => c.text ?? '').join('')).toContain(
        'from-second',
      )

      // A THIRD client after the second closes: the child stays initialized once.
      await second.close()
      const third = await open('integration-third')
      try {
        const thirdList = await third.listTools()
        expect(thirdList.tools).toHaveLength(13)
        const e3 = await third.callTool({ name: 'echo', arguments: { message: 'from-third' } })
        expect(((e3.content ?? []) as Array<{ text?: string }>).map((c) => c.text ?? '').join('')).toContain(
          'from-third',
        )
      } finally {
        await third.close().catch(() => {})
      }
    } finally {
      await second.close().catch(() => {})
    }
  })
})

test.skipIf(!unavailable)('skips gracefully when server-everything is unavailable', () => {
  // A placeholder so the file reports a (passing) result offline instead of an
  // empty run — documents that the skip path is intentional, not a silent gap.
  expect(unavailable).toBe(true)
})
