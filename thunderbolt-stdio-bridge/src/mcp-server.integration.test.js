/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

'use strict'

// Offline-tolerant integration test: drives the REAL
// @modelcontextprotocol/server-everything child through the OFFICIAL MCP client
// over the real HTTP face, with no mocks. It resolves server-everything locally
// (no network) and SKIPS the whole suite when the dependency is unavailable, so
// CI stays green offline.

const { test, describe, expect, beforeAll, afterAll } = require('bun:test')
const path = require('node:path')
const { Client } = require('@modelcontextprotocol/sdk/client/index.js')
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js')
const { makeLogger } = require('./log')
const { startMcpFace } = require('./mcp-server')

/**
 * Resolve a launch argv for server-everything from the locally-installed package
 * (no network). Returns null when the dependency isn't installed, so the suite
 * skips rather than failing offline.
 * @returns {string[]|null}
 */
const resolveServerEverythingLaunch = () => {
  try {
    const pkgPath = require.resolve('@modelcontextprotocol/server-everything/package.json')
    const pkg = require(pkgPath)
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
  /** @type {{ url: string, close(): Promise<void> }|null} */
  let face = null
  /** @type {Client|null} */
  let client = null

  beforeAll(async () => {
    const logger = makeLogger({ json: false, verbose: false, sink: process.stderr })
    face = await startMcpFace({
      launch,
      host: '127.0.0.1',
      port: 0,
      allowOrigins: [],
      allowAnyOrigin: false,
      logger,
    })
    client = new Client({ name: 'integration-test', version: '0.0.0' })
    const transport = new StreamableHTTPClientTransport(new URL(face.url))
    await client.connect(transport)
  })

  afterAll(async () => {
    // Always teardown so no child/socket leaks even on assertion failure.
    if (client) await client.close().catch(() => {})
    if (face) await face.close()
  })

  test('initialize handshake succeeds through the face', () => {
    expect(client).not.toBeNull()
    expect(client.getServerVersion()).toBeTruthy()
  })

  test('tools/list returns a non-empty tool set', async () => {
    const { tools } = await client.listTools()
    expect(Array.isArray(tools)).toBe(true)
    expect(tools.length).toBeGreaterThan(0)
  })

  test('calling the echo tool returns a well-formed result', async () => {
    const { tools } = await client.listTools()
    const echo = tools.find((t) => t.name === 'echo')
    expect(echo).toBeTruthy()
    const result = await client.callTool({ name: 'echo', arguments: { message: 'hello bridge' } })
    const text = (result.content ?? []).map((c) => c.text ?? '').join('')
    expect(text).toContain('hello bridge')
  })
})

test.skipIf(!unavailable)('skips gracefully when server-everything is unavailable', () => {
  // A placeholder so the file reports a (passing) result offline instead of an
  // empty run — documents that the skip path is intentional, not a silent gap.
  expect(unavailable).toBe(true)
})
