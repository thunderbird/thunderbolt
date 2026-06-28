/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Browser shim for Node's legacy `constants` / `node:constants` module, aliased in
 * `vite.config.ts` for the in-browser Pi harness path.
 *
 * Why this exists: `graceful-fs` (pulled in transitively by Pi) does
 * `require('constants')` and then calls `constants.hasOwnProperty('O_SYMLINK')`.
 * Vite's default `browser-external:constants` returns a proxy whose
 * `hasOwnProperty` is not callable, throwing during graceful-fs's patch step. A
 * plain CommonJS object restores `hasOwnProperty`; omitting the exotic flags
 * (e.g. `O_SYMLINK`) makes graceful-fs skip the `lchmod`/`lchown` patches it would
 * otherwise install — none of which the browser harness needs.
 */

module.exports = {
  F_OK: 0,
  R_OK: 4,
  W_OK: 2,
  X_OK: 1,
  O_RDONLY: 0,
  O_WRONLY: 1,
  O_RDWR: 2,
  O_CREAT: 64,
  O_EXCL: 128,
  O_TRUNC: 512,
  O_APPEND: 1024,
  S_IFMT: 61440,
  S_IFREG: 32768,
  S_IFDIR: 16384,
}
