/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Browser shim for Node's `module` / `node:module`, aliased in `vite.config.ts`
 * for the in-browser Pi harness path.
 *
 * Why this exists: `just-bash`'s browser bundle evaluates
 * `createRequire(import.meta.url)` at MODULE SCOPE. Vite's `browser-external:module`
 * leaves `createRequire` undefined, so that top-level call throws on import (the
 * production build tree-shakes the unused `require`, but the dev server does not).
 *
 * The returned `require` resolves the handful of Node builtins still aliased on
 * this path (`crypto`/`fs/promises`/`path`) to their browser shims, so a lazy
 * `require('crypto')` behaves like the static `import`. Anything else throws —
 * loudly, since a real native `require` cannot be satisfied in the browser.
 */

// Imported via bare builtin specifiers: typed by @types/node for the type-checker,
// redirected to the browser shims by vite.config.ts's resolve.alias at build time.
import nodeCrypto from 'node:crypto'
import nodeFsPromises from 'node:fs/promises'
import nodePath from 'node:path'

/** Node builtins that may be `require()`-d lazily, mapped to their browser shims. */
const browserBuiltins: Record<string, unknown> = {
  crypto: nodeCrypto,
  'node:crypto': nodeCrypto,
  'fs/promises': nodeFsPromises,
  'node:fs/promises': nodeFsPromises,
  path: nodePath,
  'node:path': nodePath,
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
