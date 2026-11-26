/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/** One of the app's own files. A missing one fails with its status, rather than as a module that does not compile. */
export const fetchAsset = async (url: string) => {
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`${url} answered ${response.status}`)
  }
  return response
}

/** The bytes of one of the app's own files, such as a WebAssembly module a Worker loads on first use. */
export const loadBytes = async (url: string) => new Uint8Array(await (await fetchAsset(url)).arrayBuffer())
