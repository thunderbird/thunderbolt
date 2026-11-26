/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { rasterType } from './raster-type'

/**
 * The most pixels a preview lets its pictures decode to, about 160 MB of bitmap: a 24-megapixel photo fits, one
 * picture of 8,192 by 8,192 does not.
 */
export const maxPicturePixels = 40_000_000

// JPEG start-of-frame markers, which carry the image's size; C4, C8 and CC are other segments.
const jpegFrames = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf])

/** A JPEG's width times height, from its first start-of-frame segment. */
const jpegPixels = (view: DataView) => {
  let at = 2
  while (at + 9 <= view.byteLength) {
    if (view.getUint8(at) !== 0xff) {
      return undefined
    }
    const marker = view.getUint8(at + 1)
    if (jpegFrames.has(marker)) {
      return view.getUint16(at + 5) * view.getUint16(at + 7)
    }
    // A fill byte, or a marker with no segment after it.
    const standalone = marker === 0xff || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)
    at += standalone ? (marker === 0xff ? 1 : 2) : 2 + view.getUint16(at + 2)
  }
  return undefined
}

/**
 * A GIF's width times height: its logical screen, grown to hold its first frame as browsers grow it. The frame's
 * offset counts too, which can only overstate the size. Past the screen descriptor and its global color table come
 * extension blocks, each a run of sub-blocks, then the frame's image descriptor; with no frame, there is no size.
 */
const gifPixels = (view: DataView) => {
  const packed = view.getUint8(10)
  let at = 13 + (packed & 0x80 ? 3 << ((packed & 0x07) + 1) : 0)
  while (view.getUint8(at) === 0x21) {
    at += 2
    while (view.getUint8(at) !== 0) {
      at += 1 + view.getUint8(at)
    }
    at += 1
  }
  if (view.getUint8(at) !== 0x2c) {
    return undefined
  }
  const width = Math.max(view.getUint16(6, true), view.getUint16(at + 1, true) + view.getUint16(at + 5, true))
  const height = Math.max(view.getUint16(8, true), view.getUint16(at + 3, true) + view.getUint16(at + 7, true))
  return width * height
}

/** A WebP's width times height, from its lossy, lossless or extended header. */
const webpPixels = (view: DataView) => {
  const chunk = String.fromCharCode(...[12, 13, 14, 15].map((i) => view.getUint8(i)))
  if (chunk === 'VP8 ') {
    return (view.getUint16(26, true) & 0x3fff) * (view.getUint16(28, true) & 0x3fff)
  }
  if (chunk === 'VP8L') {
    const bits = view.getUint32(21, true)
    return ((bits & 0x3fff) + 1) * (((bits >>> 14) & 0x3fff) + 1)
  }
  if (chunk === 'VP8X') {
    const uint24 = (at: number) => view.getUint16(at, true) | (view.getUint8(at + 2) << 16)
    return (uint24(24) + 1) * (uint24(27) + 1)
  }
  return undefined
}

/**
 * How many pixels a raster image decodes to, read from its header before anything decodes it, or `undefined` when
 * the header cannot be read. A picture of a few kilobytes can claim 16,384 by 16,384 pixels, a gigabyte of bitmap.
 */
export const rasterPixels = (bytes: Uint8Array) => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  try {
    switch (rasterType(bytes)) {
      case 'image/png':
        return view.getUint32(16) * view.getUint32(20)
      case 'image/gif':
        return gifPixels(view)
      case 'image/bmp':
        return Math.abs(view.getInt32(18, true)) * Math.abs(view.getInt32(22, true))
      case 'image/webp':
        return webpPixels(view)
      case 'image/jpeg':
        return jpegPixels(view)
      default:
        return undefined
    }
  } catch {
    // A header cut short of its size fields.
    return undefined
  }
}
