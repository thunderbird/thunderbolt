/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { test, expect, mock, type Mock } from 'bun:test'
import { EventEmitter } from 'node:events'
import { startTunnel, generateBearer, BEARER_BYTES } from './tunnel'
import type { SpawnFn } from './types'

/** Capturing logger that records every event/text line written. */
const makeLogger = () => {
  const lines: string[] = []
  return {
    lines,
    info: mock((event: string) => lines.push(`info ${event}`)),
    warn: mock((event: string) => lines.push(`warn ${event}`)),
    error: mock((event: string) => lines.push(`error ${event}`)),
    banner: mock((url: string) => lines.push(`banner ${url}`)),
  }
}

/** Fake cloudflared child: EventEmitter with a stderr stream + kill capture. */
type FakeChild = EventEmitter & {
  stderr: EventEmitter
  exitCode: number | null
  signalCode: NodeJS.Signals | null
  signals: (NodeJS.Signals | undefined)[]
  kill: Mock<(signal?: NodeJS.Signals) => boolean>
}

const makeChild = (): FakeChild => {
  const child = new EventEmitter() as FakeChild
  child.stderr = new EventEmitter()
  child.exitCode = null
  child.signalCode = null
  child.signals = []
  child.kill = mock((sig?: NodeJS.Signals) => {
    child.signals.push(sig)
    return true
  })
  return child
}

/** A fake child_process.spawn that always returns the given fake cloudflared child. */
const fakeSpawn = (child: FakeChild): SpawnFn => (() => child) as unknown as SpawnFn

test('spawns cloudflared with `tunnel --url <localUrl>`', async () => {
  const logger = makeLogger()
  const child = makeChild()
  const spawn = mock(() => child)
  const promise = startTunnel({
    localUrl: 'http://127.0.0.1:5000/mcp',
    bearer: 'b',
    logger,
    spawn: spawn as unknown as SpawnFn,
  })
  child.stderr.emit('data', Buffer.from('INF |  https://happy-cloud-1.trycloudflare.com  |\n'))
  await promise
  expect(spawn).toHaveBeenCalledWith('cloudflared', ['tunnel', '--url', 'http://127.0.0.1:5000/mcp'])
})

test('parses the https://*.trycloudflare.com URL from stderr and resolves publicUrl', async () => {
  const logger = makeLogger()
  const child = makeChild()
  const promise = startTunnel({ localUrl: 'http://127.0.0.1:5000/mcp', bearer: 'b', logger, spawn: fakeSpawn(child) })
  child.stderr.emit('data', Buffer.from('2024 INF Your quick Tunnel: https://abc-def-ghi.trycloudflare.com\n'))
  const { publicUrl } = await promise
  expect(publicUrl).toBe('https://abc-def-ghi.trycloudflare.com')
})

test('the public URL is recognized when emitted SPLIT across two stderr chunks', async () => {
  const logger = makeLogger()
  const child = makeChild()
  const promise = startTunnel({ localUrl: 'http://127.0.0.1:5000/mcp', bearer: 'b', logger, spawn: fakeSpawn(child) })
  child.stderr.emit('data', Buffer.from('2024 INF Your quick Tunnel: https://abc-'))
  child.stderr.emit('data', Buffer.from('def.trycloudflare.com\n'))
  const { publicUrl } = await promise
  expect(publicUrl).toBe('https://abc-def.trycloudflare.com')
})

test('generateBearer mints a high-entropy (>=256 bits) base64url bearer from randomBytes', () => {
  let requestedBytes = 0
  const randomBytes = (n: number) => {
    requestedBytes = n
    return Buffer.alloc(n, 3)
  }
  const bearer = generateBearer(randomBytes)
  expect(requestedBytes).toBe(BEARER_BYTES)
  expect(BEARER_BYTES * 8).toBeGreaterThanOrEqual(256)
  expect(bearer).toBe(Buffer.alloc(BEARER_BYTES, 3).toString('base64url'))
})

test('generateBearer produces distinct bearers for distinct randomBytes', () => {
  const a = generateBearer((n) => Buffer.alloc(n, 1))
  const b = generateBearer((n) => Buffer.alloc(n, 2))
  expect(a).not.toBe(b)
})

test('the bearer is logged to stderr and NEVER appears in publicUrl or any query string', async () => {
  const logger = makeLogger()
  const child = makeChild()
  const bearer = 'super-secret-bearer-value'
  const promise = startTunnel({ localUrl: 'http://127.0.0.1:5000/mcp', bearer, logger, spawn: fakeSpawn(child) })
  child.stderr.emit('data', Buffer.from('https://secret-tunnel.trycloudflare.com\n'))
  const { publicUrl } = await promise
  expect(publicUrl).not.toContain(bearer)
  expect(publicUrl).not.toContain('?')
  // The bearer must have been written to the (stderr) logger.
  const bearerLogged = logger.warn.mock.calls.some((c) => c.some((arg) => String(arg).includes(bearer)))
  expect(bearerLogged).toBe(true)
})

test('cloudflared ENOENT rejects with an unavailable error (→69) and a "not found" message', async () => {
  const logger = makeLogger()
  const child = makeChild()
  const promise = startTunnel({ localUrl: 'http://127.0.0.1:5000/mcp', bearer: 'b', logger, spawn: fakeSpawn(child) })
  child.emit('error', Object.assign(new Error('spawn cloudflared ENOENT'), { code: 'ENOENT' }))
  await expect(promise).rejects.toMatchObject({ name: 'UnavailableError', code: 'ENOENT' })
  await expect(promise).rejects.toThrow(/not found/)
})

test('a timeout with no URL printed rejects with an unavailable error (→69) and SIGKILLs', async () => {
  const logger = makeLogger()
  const child = makeChild()
  const promise = startTunnel({
    localUrl: 'http://127.0.0.1:5000/mcp',
    bearer: 'b',
    logger,
    spawn: fakeSpawn(child),
    urlTimeoutMs: 5,
  })
  await expect(promise).rejects.toMatchObject({ name: 'UnavailableError' })
  expect(child.signals).toContain('SIGKILL')
})

test('close() SIGTERMs then SIGKILLs cloudflared (grace window): no orphan', async () => {
  const logger = makeLogger()
  const child = makeChild()
  const promise = startTunnel({ localUrl: 'http://127.0.0.1:5000/mcp', bearer: 'b', logger, spawn: fakeSpawn(child) })
  child.stderr.emit('data', Buffer.from('https://x.trycloudflare.com\n'))
  const { close } = await promise
  const closing = close()
  expect(child.signals).toContain('SIGTERM')
  // The child reports exit within the grace window → no SIGKILL needed.
  child.exitCode = 0
  child.emit('exit', 0, null)
  await closing
})

test('close() is a no-op when cloudflared already exited', async () => {
  const logger = makeLogger()
  const child = makeChild()
  const promise = startTunnel({ localUrl: 'http://127.0.0.1:5000/mcp', bearer: 'b', logger, spawn: fakeSpawn(child) })
  child.stderr.emit('data', Buffer.from('https://x.trycloudflare.com\n'))
  const { close } = await promise
  child.exitCode = 0
  await close()
  expect(child.signals).not.toContain('SIGTERM')
})

test('startTunnel returns the caller-supplied bearer verbatim', async () => {
  const logger = makeLogger()
  const child = makeChild()
  const promise = startTunnel({
    localUrl: 'http://127.0.0.1:5000/mcp',
    bearer: 'caller-bearer',
    logger,
    spawn: fakeSpawn(child),
  })
  child.stderr.emit('data', Buffer.from('https://x.trycloudflare.com\n'))
  const { bearer } = await promise
  expect(bearer).toBe('caller-bearer')
})
