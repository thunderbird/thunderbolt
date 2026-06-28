/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Browser shim for Node's `fs` / `node:fs`, aliased in `vite.config.ts` for the
 * in-browser Pi harness path.
 *
 * Why this exists: Pi's package/config detection probes the disk with sync `fs`
 * calls (`existsSync`, `readFileSync`, …). Vite's default `browser-external:fs`
 * leaves them undefined, throwing on call. The harness does its REAL file I/O
 * through the ZenFS-backed operation adapters (see `coding-tool-operations.ts`),
 * never through these — so this shim presents an *empty* filesystem: `existsSync`
 * returns false (Pi falls back to its defaults), reads throw `ENOENT`, and writes
 * are inert no-ops.
 *
 * Why CommonJS (not the ESM `.ts` used by the sibling shims): `graceful-fs`
 * monkey-patches the `fs` module in place (`fs.closeSync = …`). ES module named
 * exports are read-only bindings, so an ESM shim throws
 * "Cannot set property closeSync … which has only a getter". A CJS `module.exports`
 * object is plain and mutable, so the (harmless, browser-irrelevant) patching
 * succeeds and the harness loads.
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
