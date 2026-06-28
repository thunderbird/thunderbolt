/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Browser stub for `cross-spawn`, aliased in `vite.config.ts` for the in-browser
 * Pi harness path.
 *
 * Why this exists: Pi's `@earendil-works/pi-coding-agent` pulls `cross-spawn` in
 * through its Node child-process helper. The real package evaluates
 * `process.platform` at *module scope* (`lib/parse.js`, `lib/enoent.js`), so
 * merely importing it throws `ReferenceError: process is not defined` in the
 * browser — before any LLM call. A runtime `globalThis.process` shim can't help
 * because the optimized dep evaluates `process` the moment the chunk loads, so
 * the fix must be build-level: replace the module entirely.
 *
 * Why it's safe: the app harness never resolves OS executables. Bash runs through
 * {@link BrowserExecutionEnv} (just-bash over ZenFS), and the read/write/edit
 * tools are bound to the same ZenFS mount — none of them touch `child_process`.
 * This module is therefore dead weight on the browser path.
 *
 * Why it throws rather than no-ops: reaching this code would mean execution was
 * wrongly routed through Node's `child_process`, which is an architectural bug we
 * want to surface loudly, not silence.
 */

/** Loudly reject any browser call into the Node child-process path. */
const browserUnsupported = (..._args: unknown[]): never => {
  throw new Error('cross-spawn is unavailable in the browser; execution runs through BrowserExecutionEnv')
}

/** Mirrors the shape `cross-spawn` consumers expect (callable + `.sync`/`.spawn`). */
type CrossSpawn = {
  (...args: unknown[]): never
  sync: (...args: unknown[]) => never
  spawn: (...args: unknown[]) => never
}

const crossSpawn = browserUnsupported as CrossSpawn
crossSpawn.sync = browserUnsupported
crossSpawn.spawn = browserUnsupported

// Named exports too, so every access path (`import cs`, `import { sync }`) throws
// loudly rather than relying on CJS-interop synthesizing the named bindings.
export const sync = browserUnsupported
export const spawn = browserUnsupported
export default crossSpawn
