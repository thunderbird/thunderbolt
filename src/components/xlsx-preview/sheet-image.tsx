/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { rasterType } from '@/office/raster-type'
import type { Overlay } from '@/office/xlsx-preview-reader'
import { useEffect, useState } from 'react'

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
