/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Installs a global `Buffer` for the in-browser harness. Pi's coding tools and
 * the ZenFS operation adapters speak Node `Buffer` (the read/edit operations
 * return `Buffer`, bash output is wrapped in `Buffer`, and Pi's coding-agent
 * internals call `Buffer` too), but browsers expose no global `Buffer`. This
 * shims it from the `buffer` package once, before the harness runs.
 */

import { Buffer as BufferPolyfill } from 'buffer'

/**
 * Ensure `globalThis.Buffer` exists, idempotently. A no-op in any environment
 * that already provides `Buffer` (Node, Bun, or a host that polyfilled it).
 */
export const ensureBufferPolyfill = (): void => {
  const scope: { Buffer?: unknown } = globalThis
  scope.Buffer ??= BufferPolyfill
}
