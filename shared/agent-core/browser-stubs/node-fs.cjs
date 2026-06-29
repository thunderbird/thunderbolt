/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Browser shim for Node's `fs` / `node:fs`, aliased in `vite.config.ts` for the
 * in-browser Pi harness path.
 *
 * Why this exists: `@earendil-works/pi-ai`'s `utils/provider-env.js` does a
 * `require("node:fs")` for a Bun-sandbox `/proc/self/environ` fallback. The call
 * is guarded by `process.versions?.bun` (always falsy in the browser) so it never
 * runs here, but rolldown still resolves the specifier statically — without this
 * alias it falls back to `browser-external:fs`, a build warning whose members
 * throw on access. This shim resolves it cleanly to an *empty* filesystem:
 * `existsSync` returns false, reads throw `ENOENT`, writes are inert no-ops. (The
 * harness's REAL file I/O goes through the ZenFS adapters, never through these.)
 *
 * Why CommonJS: the sole consumer reaches it via `require("node:fs")`, so a plain
 * `module.exports` object is the natural, interop-free target.
 */

/** Build a Node-style ENOENT error so Pi's error handling reads it as "missing". */
const enoent = (path) => {
  const error = new Error(`ENOENT: no such file or directory, '${path}'`)
  error.code = 'ENOENT'
  return error
}

/** No-op file watcher: callers only ever `.close()` it. */
const noopWatcher = { close: () => {}, on: () => noopWatcher, unref: () => noopWatcher, ref: () => noopWatcher }

module.exports = {
  constants: { F_OK: 0, R_OK: 4, W_OK: 2, X_OK: 1, O_RDONLY: 0, O_WRONLY: 1, O_RDWR: 2 },

  existsSync: () => false,
  readFileSync: (path) => {
    throw enoent(path)
  },
  readSync: () => {
    throw new Error('fs.readSync is unavailable in the browser Pi harness')
  },
  openSync: (path) => {
    throw enoent(path)
  },
  statSync: (path) => {
    throw enoent(path)
  },
  lstatSync: (path) => {
    throw enoent(path)
  },
  readlinkSync: (path) => {
    throw enoent(path)
  },
  /** Callback-style `fs.readdir`: report an empty directory. */
  readdir: (_path, optionsOrCb, maybeCb) => {
    const callback = typeof optionsOrCb === 'function' ? optionsOrCb : maybeCb
    if (typeof callback === 'function') {
      callback(null, [])
    }
  },
  readdirSync: () => [],
  accessSync: (path) => {
    throw enoent(path)
  },
  createReadStream: (path) => {
    throw enoent(path)
  },
  createWriteStream: () => {
    throw new Error('fs.createWriteStream is unavailable in the browser Pi harness')
  },
  /** Identity: with no real symlinks, the resolved path is the input path. */
  realpathSync: (path) => path,

  writeFileSync: () => {},
  appendFileSync: () => {},
  mkdirSync: () => {},
  rmSync: () => {},
  renameSync: () => {},
  copyFileSync: () => {},
  unlinkSync: () => {},
  chmodSync: () => {},
  closeSync: () => {},

  watch: () => noopWatcher,
  watchFile: () => {},
  unwatchFile: () => {},

  /** Async surface, for code reaching `fs.promises` through the namespace. */
  promises: {
    access: (path) => Promise.reject(enoent(path)),
    readFile: (path) => Promise.reject(enoent(path)),
    stat: (path) => Promise.reject(enoent(path)),
    lstat: (path) => Promise.reject(enoent(path)),
    readlink: (path) => Promise.reject(enoent(path)),
    realpath: (path) => Promise.resolve(path),
    readdir: () => Promise.resolve([]),
    writeFile: () => Promise.resolve(),
    appendFile: () => Promise.resolve(),
    mkdir: () => Promise.resolve(undefined),
    mkdtemp: (prefix) => Promise.resolve(`${prefix}browser`),
    rm: () => Promise.resolve(),
    unlink: () => Promise.resolve(),
  },
}
