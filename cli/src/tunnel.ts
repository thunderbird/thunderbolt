// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

// Stand up a cloudflared quick tunnel in front of the local MCP face (MCP only).
// Spawns `cloudflared tunnel --url <localUrl>`, parses the assigned
// *.trycloudflare.com URL from cloudflared's stderr, and fronts the face with a
// caller-minted mandatory bearer. The bearer is printed to STDERR ONLY and never
// embedded in the public URL or any query string — mcp-server.js compares it
// constant-time on every request.

import { spawn as defaultSpawn } from 'node:child_process'
import { randomBytes as defaultRandomBytes } from 'node:crypto'
import { UnavailableError } from './errors'
import type { GenerateBearer, StartTunnel } from './types'

/** Entropy of the minted bearer: 32 bytes => 256 bits. */
const BEARER_BYTES = 32
/** Grace window before SIGKILLing cloudflared on close(). */
const GRACE_MS = 2000
/** Give cloudflared this long to print its public URL before declaring it unavailable. */
const URL_TIMEOUT_MS = 30000
/** Cap the accumulated stderr buffer so a chatty cloudflared can't grow it unbounded. */
const STDERR_BUFFER_CAP = 64 * 1024
/** Matches the quick-tunnel URL cloudflared prints to its stderr. */
const TRYCLOUDFLARE_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i

/**
 * Mint a high-entropy bearer for fronting the MCP face. 32 bytes => 256 bits,
 * base64url-encoded so it's safe to carry verbatim in an Authorization header.
 */
const generateBearer: GenerateBearer = (randomBytes = defaultRandomBytes) =>
  randomBytes(BEARER_BYTES).toString('base64url')

/**
 * Start a cloudflared quick tunnel in front of `localUrl`, fronted by the
 * caller-supplied mandatory bearer. Resolves once cloudflared prints its public
 * URL; rejects with an UnavailableError if cloudflared is missing (ENOENT) or
 * never prints a URL in time. The bearer is logged to stderr — never put in the
 * URL.
 */
const startTunnel: StartTunnel = ({
  localUrl,
  bearer,
  logger,
  spawn = defaultSpawn,
  urlTimeoutMs = URL_TIMEOUT_MS,
}) => {
  return new Promise((resolve, reject) => {
    const settled = { done: false }
    const child = spawn('cloudflared', ['tunnel', '--url', localUrl])

    let graceTimer: NodeJS.Timeout | null = null
    const clearGrace = () => {
      if (graceTimer) {
        clearTimeout(graceTimer)
        graceTimer = null
      }
    }

    const close = (): Promise<void> =>
      new Promise((resolveClose) => {
        if (child.exitCode !== null || child.signalCode !== null) {
          clearGrace()
          resolveClose()
          return
        }
        child.once('exit', () => {
          clearGrace()
          resolveClose()
        })
        child.kill('SIGTERM')
        graceTimer = setTimeout(() => child.kill('SIGKILL'), GRACE_MS)
        if (typeof graceTimer.unref === 'function') graceTimer.unref()
      })

    const urlTimer = setTimeout(() => {
      if (settled.done) return
      settled.done = true
      child.kill('SIGKILL') // never-orphan
      reject(new UnavailableError({ message: 'cloudflared did not report a tunnel URL in time' }))
    }, urlTimeoutMs)
    if (typeof urlTimer.unref === 'function') urlTimer.unref()

    child.on('error', (err: NodeJS.ErrnoException) => {
      if (settled.done) return
      settled.done = true
      clearTimeout(urlTimer)
      // ENOENT => cloudflared not installed; surface as unavailable (cli -> 69).
      reject(new UnavailableError({ code: err.code, message: 'cloudflared not found' }))
    })

    // cloudflared prints diagnostics — including the assigned URL — to stderr.
    // Accumulate across chunks so a URL split over two `data` events still
    // matches; cap the buffer so a chatty cloudflared can't grow it unbounded.
    let stderrBuffer = ''
    child.stderr!.on('data', (chunk: Buffer) => {
      if (settled.done) return
      stderrBuffer = (stderrBuffer + chunk.toString('utf8')).slice(-STDERR_BUFFER_CAP)
      const match = TRYCLOUDFLARE_RE.exec(stderrBuffer)
      if (!match) return
      settled.done = true
      clearTimeout(urlTimer)
      const publicUrl = match[0]
      // Bearer to STDERR ONLY — never in the URL or a query param. The bearer is
      // a secret, so it rides in the event string (printed verbatim) rather than
      // a scalar field (which the allowlist would drop anyway).
      logger.banner(publicUrl)
      logger.warn(`tunnel-bearer Authorization: Bearer ${bearer}`)
      resolve({ publicUrl, bearer, close })
    })
  })
}

export { startTunnel, generateBearer, BEARER_BYTES }
