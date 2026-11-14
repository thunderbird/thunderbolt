/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { Overlay } from '@/office/xlsx-preview-reader'
import { useEffect, useState } from 'react'

const startsWith = (bytes: Uint8Array, signature: number[], at = 0) =>
  signature.every((byte, i) => bytes[at + i] === byte)

const ascii = (text: string) => [...text].map((c) => c.charCodeAt(0))

/**
 * The type of a raster image, by its first bytes, or `undefined` for anything else, SVG included. An `<img>` would
 * not run an SVG's scripts, but allowing raster types only leaves nothing to reason about.
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

/**
 * One `blob:` URL for each distinct picture the overlays show, made from the bytes in the file and revoked when the
 * overlays change or unmount. No URL from the file is ever used. A picture the file anchors many times gets one URL,
 * because the Worker sends its bytes once.
 */
export const useImageUrls = (overlays: Overlay[]) => {
  const [urls, setUrls] = useState(() => new Map<Uint8Array, string>())

  useEffect(() => {
    const made = new Map<Uint8Array, string>()
    for (const overlay of overlays) {
      const type = overlay.type === 'image' && !made.has(overlay.bytes) ? rasterType(overlay.bytes) : undefined
      if (overlay.type === 'image' && type) {
        made.set(overlay.bytes, URL.createObjectURL(new Blob([new Uint8Array(overlay.bytes)], { type })))
      }
    }
    setUrls(made)
    return () => {
      for (const url of made.values()) {
        URL.revokeObjectURL(url)
      }
    }
  }, [overlays])

  return urls
}
