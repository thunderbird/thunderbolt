/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Decode the first QR code found in an image file and return its raw text payload.
 * `jsqr` is imported dynamically so it stays out of the entry bundle until a scan happens.
 * Throws if the canvas is unavailable or no QR code is detected.
 */
export const decodeQrFromFile = async (file: File): Promise<string> => {
  const { default: jsQR } = await import('jsqr')
  const bitmap = await createImageBitmap(file)
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
}
