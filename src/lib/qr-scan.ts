/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/** Reject an image larger than this before decoding. A self-uploaded but huge or
 *  dense raster would otherwise freeze the main thread in getImageData + jsQR. */
const maxImageBytes = 15 * 1024 * 1024
/** Cap the scanned raster's longest edge. QR codes survive downscaling, and this
 *  bounds the getImageData + jsQR cost regardless of the source resolution. */
const maxScanEdge = 2048

/**
 * Decode the first QR code found in an image file and return its raw text payload.
 * `jsqr` is imported dynamically so it stays out of the entry bundle until a scan happens.
 * The image is rejected unless it is a bounded raster, and the decode itself is bounded
 * to {@link maxScanEdge} on each edge so a large upload can't freeze the main thread.
 * Throws if the file isn't a valid image, the canvas is unavailable, or no QR code is detected.
 */
export const decodeQrFromFile = async (file: File): Promise<string> => {
  if (!file.type.startsWith('image/')) {
    throw new Error('File is not an image')
  }
  if (file.size > maxImageBytes) {
    throw new Error('Image is too large to scan')
  }

  const { default: jsQR } = await import('jsqr')
  // Bound the DECODE, not just the post-decode raster. `createImageBitmap(file)`
  // with no options decodes at the source's *declared* resolution first, so a
  // few-KB "decompression bomb" (e.g. a 30000×30000 PNG) would allocate gigabytes
  // before any canvas downscale could help — and the byte/edge caps above never
  // see it. Passing `resizeWidth`/`resizeHeight` caps each edge during decode, so
  // the bitmap can never exceed maxScanEdge². jsQR's perspective correction
  // tolerates the resulting aspect-ratio change on non-square sources.
  const bitmap = await createImageBitmap(file, {
    resizeWidth: maxScanEdge,
    resizeHeight: maxScanEdge,
    resizeQuality: 'medium',
  })
  try {
    const canvas = document.createElement('canvas')
    canvas.width = bitmap.width
    canvas.height = bitmap.height

    const ctx = canvas.getContext('2d')
    if (!ctx) {
      throw new Error('Canvas 2D context is unavailable')
    }

    ctx.drawImage(bitmap, 0, 0)
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height)
    const result = jsQR(imageData.data, imageData.width, imageData.height)
    if (!result) {
      throw new Error('No QR code found in the image')
    }

    return result.data
  } finally {
    bitmap.close()
  }
}
