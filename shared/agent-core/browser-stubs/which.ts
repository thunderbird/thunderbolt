/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Browser stub for `which`, aliased in `vite.config.ts` for the in-browser Pi
 * harness path. See `./cross-spawn.ts` for the full rationale — `which` is the
 * sibling executable-resolution module (`cross-spawn` resolves commands through
 * it) and likewise evaluates `process.platform`/`process.env` at module scope,
 * throwing `ReferenceError: process is not defined` on import in the browser.
 *
 * The harness never resolves OS executables (bash runs through
 * {@link BrowserExecutionEnv}), so this module is dead weight on the browser
 * path. It throws if ever called so a mis-routed execution surfaces loudly
 * instead of silently no-op'ing.
 */

/** Loudly reject any browser call into OS executable resolution. */
const browserUnsupported = (..._args: unknown[]): never => {
  throw new Error('which is unavailable in the browser; execution runs through BrowserExecutionEnv')
}

/** Mirrors the shape `which` consumers expect (callable + `.sync`). */
type Which = {
  (...args: unknown[]): never
  sync: (...args: unknown[]) => never
}

const which = browserUnsupported as Which
which.sync = browserUnsupported

export default which
export const sync = browserUnsupported
