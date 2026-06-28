/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Browser shim for Node's `url` / `node:url`, aliased in `vite.config.ts` for the
 * in-browser Pi harness path.
 *
 * Why this exists: Pi's `config.js` derives `__dirname` at MODULE SCOPE via
 * `fileURLToPath(import.meta.url)`, and its clipboard helper calls
 * `pathToFileURL` at load. Vite's default `browser-external:url` leaves both
 * undefined, so importing Pi throws "fileURLToPath is not a function" before any
 * LLM call. The browser harness never reads on-disk Pi config/assets, so the
 * derived paths are inert — these implementations only need to return a value
 * rather than throw. `URL`/`URLSearchParams` are browser globals, re-exported for
 * parity with the Node module surface.
 */

/** Browser `fileURLToPath`: return the URL's pathname (file:// or http(s)://). */
export const fileURLToPath = (url: string | URL): string => new globalThis.URL(url).pathname

/** Browser `pathToFileURL`: wrap an absolute path as a `file://` URL. */
export const pathToFileURL = (path: string): URL => new globalThis.URL(`file://${path}`)

// Re-export the browser globals under the Node module's names (globals can't be
// re-exported directly, so alias through local bindings).
const url = globalThis.URL
const urlSearchParams = globalThis.URLSearchParams

const nodeUrl = { fileURLToPath, pathToFileURL, URL: url, URLSearchParams: urlSearchParams }

export { url as URL, urlSearchParams as URLSearchParams }
export default nodeUrl
