/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Browser shim for Node's `os` / `node:os`, aliased in `vite.config.ts` for the
 * in-browser Pi harness path.
 *
 * Why this exists: Pi resolves its config directory from `os.homedir()` and a few
 * helpers read `os.tmpdir()`/`os.platform()`. Vite's default `browser-external:os`
 * leaves them undefined, throwing on call. The harness keeps no on-disk config
 * (it uses an in-memory session repo and a ZenFS sandbox), so these only need to
 * return stable, sane values rather than reflect a real host.
 */

/** A stable virtual home directory; the harness never reads it. */
export const homedir = (): string => '/home/user'

/** A stable virtual temp directory; real temp I/O goes through ZenFS. */
export const tmpdir = (): string => '/tmp'

/** Report a browser "platform" so Pi takes its non-Windows code paths. */
export const platform = (): string => 'browser'

/** WebAssembly-ish arch label; only used in diagnostics Pi never shows here. */
export const arch = (): string => 'wasm'

/** Browsers are LF-only. */
export const EOL = '\n'

/** No CPU topology in the browser. */
export const cpus = (): unknown[] => []

/** Stable host label. */
export const hostname = (): string => 'browser'

export default { homedir, tmpdir, platform, arch, EOL, cpus, hostname }
