/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const startsWith = (bytes: Uint8Array, signature: number[], at = 0) =>
  signature.every((byte, i) => bytes[at + i] === byte)

const ascii = (text: string) => [...text].map((c) => c.charCodeAt(0))

/**
 * The type of a raster image, by its first bytes, or `undefined` for anything else, SVG included. An `<img>` would
 * not run an SVG's scripts, but allowing raster types only leaves nothing to reason about. Free of other imports, as
 * both the preview Worker and the grid read it.
 */
export const rasterType = (bytes: Uint8Array) => {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return 'image/png'
  }
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) {
    return 'image/jpeg'
  }
  if (startsWith(bytes, ascii('GIF8'))) {
    return 'image/gif'
  }
  if (startsWith(bytes, ascii('RIFF')) && startsWith(bytes, ascii('WEBP'), 8)) {
    return 'image/webp'
  }
  return startsWith(bytes, ascii('BM')) ? 'image/bmp' : undefined
}
