/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const fixtureDir = mkdtempSync(join(tmpdir(), 'thunderbolt-nginx-'))
const containerName = `thunderbolt-nginx-test-${process.pid}`
const image = 'nginxinc/nginx-unprivileged:alpine'
let origin: string

/** Runs the same nginx image and configuration as the deployed frontend. */
const docker = (...args: string[]) => execFileSync('docker', args, { encoding: 'utf8' }).trim()

beforeAll(async () => {
  // nginx runs as a different UID on Linux; mkdtemp defaults to owner-only access.
  chmodSync(fixtureDir, 0o755)
  mkdirSync(join(fixtureDir, 'assets'))
  writeFileSync(join(fixtureDir, 'index.html'), '<!doctype html><title>Current build</title>')
  writeFileSync(join(fixtureDir, 'assets', 'entry-current.js'), 'console.log("current")')
  writeFileSync(join(fixtureDir, 'assets', 'entry-current.js.map'), '{}')
  docker(
    'run',
    '--detach',
    '--rm',
    '--name',
    containerName,
    '--publish',
    '127.0.0.1::8080',
    '--env',
    'THUNDERBOLT_BACKEND_HOST=127.0.0.1',
    '--env',
    'THUNDERBOLT_BACKEND_PORT=9',
    '--volume',
    `${fixtureDir}:/usr/share/nginx/html:ro`,
    '--volume',
    `${import.meta.dir}/nginx.conf.template:/etc/nginx/templates/default.conf.template:ro`,
    '--volume',
    `${import.meta.dir}/security-headers.conf:/etc/nginx/snippets/security-headers.conf:ro`,
    image,
  )
  origin = `http://${docker('port', containerName, '8080/tcp')}`
  // Startup readiness is bounded; errors from assertions below are never retried.
  const deadline = Date.now() + 10_000
  while (true) {
    try {
      await fetch(origin)
      return
    } catch (error) {
      if (Date.now() >= deadline) throw error
      await Bun.sleep(100)
    }
  }
}, 30_000)

afterAll(() => {
  try {
    docker('rm', '--force', containerName)
  } finally {
    rmSync(fixtureDir, { recursive: true, force: true })
  }
})

describe('deployed frontend caching', () => {
  test('a missing chunk is a non-cacheable 404, then becomes available', async () => {
    const response = await fetch(`${origin}/assets/entry-next.js`)
    expect(response.status).toBe(404)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(response.headers.get('cross-origin-embedder-policy')).toBe('credentialless')
    expect(await response.text()).not.toContain('Current build')

    writeFileSync(join(fixtureDir, 'assets', 'entry-next.js'), 'console.log("next")')
    const available = await fetch(`${origin}/assets/entry-next.js`)
    expect(available.status).toBe(200)
    expect(available.headers.get('cache-control')).toContain('immutable')
  })

  test('successful hashed assets and conditional responses retain long caching', async () => {
    const response = await fetch(`${origin}/assets/entry-current.js`)
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toContain('max-age=31536000')
    expect(response.headers.get('cache-control')).toContain('immutable')
    const etag = response.headers.get('etag')
    expect(etag).not.toBeNull()
    const cached = await fetch(`${origin}/assets/entry-current.js`, {
      headers: { 'If-None-Match': etag! },
    })
    expect(cached.status).toBe(304)
    expect(cached.headers.get('cache-control')).toContain('immutable')
  })

  test.each(['/', '/index.html', '/chats/new'])('revalidates the app shell at %s', async (path) => {
    const response = await fetch(`${origin}${path}`)
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-cache')
    expect(response.headers.get('cross-origin-opener-policy')).toBe('same-origin')
    expect(await response.text()).toContain('Current build')
  })

  test('source maps remain blocked even when present on disk', async () => {
    const response = await fetch(`${origin}/assets/entry-current.js.map`)
    expect(response.status).toBe(404)
  })
})
