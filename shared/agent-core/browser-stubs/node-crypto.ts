/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Browser shim for Node's `crypto` / `node:crypto`, aliased in `vite.config.ts`
 * for the in-browser Pi harness path.
 *
 * Why this exists: Pi's runtime engine generates ids at runtime —
 * `crypto.randomUUID` (session/message ids) and `crypto.randomBytes` (tool-call
 * ids) — which Vite's default `browser-external:crypto` leaves undefined. These
 * are backed by the browser's native Web Crypto, so the shim is a thin, correct
 * delegation rather than a stub. `createHash` is not on the harness path; it
 * throws so an unexpected caller surfaces loudly instead of silently misbehaving.
 */

import { Buffer } from 'buffer'

/** Native RFC-4122 v4 UUID via Web Crypto. */
export const randomUUID = (): string => globalThis.crypto.randomUUID()

/** Node-compatible `randomBytes`: a `Buffer` of cryptographically-random bytes. */
export const randomBytes = (size: number): Buffer => {
  const bytes = new Uint8Array(size)
  globalThis.crypto.getRandomValues(bytes)
  return Buffer.from(bytes)
}

/** Fill an existing typed array with random bytes (Web Crypto, returns the array). */
export const randomFillSync = <T extends ArrayBufferView>(buffer: T): T => {
  globalThis.crypto.getRandomValues(buffer as unknown as Uint8Array)
  return buffer
}

/** The Web Crypto implementation, mirroring Node's `crypto.webcrypto`. */
export const webcrypto = globalThis.crypto

/** Not available in the browser — surfaces loudly if the harness ever needs it. */
export const createHash = (): never => {
  throw new Error('crypto.createHash is unavailable in the browser Pi harness')
}

export default { randomUUID, randomBytes, randomFillSync, webcrypto, createHash }
