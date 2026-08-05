/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Longest-edge ceiling. A >10MB image is almost always a phone photo or huge
 * screenshot far larger than any model needs; 2048px keeps fine detail (small
 * text stays legible for vision models) while shedding most of the bytes.
 */
const maxDimension = 2048

/** WebP quality — high enough to be visually lossless for photos, low enough
 *  to win big on size. WebP also preserves alpha, so PNG transparency survives. */
const quality = 0.82

/** Encode a canvas to a WebP blob, preferring OffscreenCanvas and falling back
 *  to a detached `<canvas>` element for browsers without it. */
const encodeWebp = async (bitmap: ImageBitmap, width: number, height: number): Promise<Blob> => {
  if (typeof OffscreenCanvas !== 'undefined') {
    const canvas = new OffscreenCanvas(width, height)
    const ctx = canvas.getContext('2d')
    if (!ctx) {
      throw new Error('2D context unavailable')
    }
    ctx.drawImage(bitmap, 0, 0, width, height)
    return canvas.convertToBlob({ type: 'image/webp', quality })
  }

  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) {
    throw new Error('2D context unavailable')
  }
  ctx.drawImage(bitmap, 0, 0, width, height)
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('toBlob returned null'))), 'image/webp', quality)
  })
}

/**
 * Downscale (to {@link maxDimension}) and re-encode a raster image to WebP.
 * Returns the compressed blob when it's actually smaller than the original,
 * otherwise `null` so the caller keeps the original bytes. May throw on a
 * decode/encode failure — the caller treats that as "couldn't compress" and
 * falls back to the original.
 */
export const compressImage = async (blob: Blob): Promise<Blob | null> => {
  // Phone photos (the common >10MB case) usually store rotation as an EXIF
  // orientation tag rather than baked-in pixels, and canvas → WebP drops EXIF
  // entirely. `from-image` bakes the tag into the drawn bitmap so a portrait
  // photo doesn't come out sideways with no metadata left to fix it downstream.
  const bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image' })
  const scale = Math.min(1, maxDimension / Math.max(bitmap.width, bitmap.height))
  const width = Math.round(bitmap.width * scale)
  const height = Math.round(bitmap.height * scale)
  try {
    const out = await encodeWebp(bitmap, width, height)
    return out.size < blob.size ? out : null
  } finally {
    bitmap.close()
  }
}
