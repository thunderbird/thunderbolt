/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Browser shim for Node's `module` / `node:module`, aliased in `vite.config.ts`
 * for the in-browser Pi harness path.
 *
 * Why this exists: Pi builds a CommonJS `require` via `createRequire(import.meta.url)`
 * — at module scope (its clipboard probe) and lazily at runtime (some modules
 * `require('fs')` rather than import it). Vite's `browser-external:module` leaves
 * `createRequire` undefined, throwing on import.
 *
 * The returned `require` resolves the Node builtins Pi reaches for to the same
 * browser shims the static `vite.config.ts` aliases use, so a dynamic
 * `require('fs')` behaves identically to `import … from 'fs'`. Anything else
 * (e.g. an optional native addon) throws — the only such caller wraps the lookup
 * in try/catch and falls back to `null`, so the harness still loads cleanly.
 */

// All imported via their bare builtin specifiers: typed by @types/node for the
// type-checker, redirected to the browser shims by vite.config.ts's resolve.alias
// at build time (so a dynamic `require('fs')` matches the static `import` path).
import nodeCrypto from 'node:crypto'
import nodeFs from 'node:fs'
import nodeFsPromises from 'node:fs/promises'
import nodeOs from 'node:os'
import nodeUrl from 'node:url'
import nodePath from 'node:path'

/** Node builtins Pi may `require()` at runtime, mapped to their browser shims. */
const browserBuiltins: Record<string, unknown> = {
  fs: nodeFs,
  'node:fs': nodeFs,
  'fs/promises': nodeFsPromises,
  'node:fs/promises': nodeFsPromises,
  os: nodeOs,
  'node:os': nodeOs,
  crypto: nodeCrypto,
  'node:crypto': nodeCrypto,
  path: nodePath,
  'node:path': nodePath,
  url: nodeUrl,
  'node:url': nodeUrl,
}

/** A CommonJS `require` over the browser shims; unknown ids fail loudly. */
const browserRequire = (id: string): unknown => {
  const builtin = browserBuiltins[id]
  if (builtin) {
    return builtin
  }
  throw new Error(`Cannot require '${id}' in the browser; native modules are unavailable in the Pi harness`)
}

/** Browser `createRequire`: hand back the shimmed `require`. */
export const createRequire = (): typeof browserRequire => browserRequire

export default { createRequire }
