/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Best-effort, lossless PDF shrink: re-save through pdf-lib with object streams.
 * This drops unreferenced objects and incremental-update cruft and compresses
 * the object structure — a real win for structure-heavy or repeatedly-edited
 * PDFs, a no-op for already-optimized or image-dominated ones (pdf-lib does not
 * recompress embedded images). Returns the smaller blob or `null` when the
 * re-save isn't smaller, so the caller keeps the original. Text, fonts, and
 * images are preserved exactly.
 *
 * pdf-lib is lazy-imported so it stays out of the entry bundle.
 */
export const compressPdf = async (blob: Blob): Promise<Blob | null> => {
  const { PDFDocument } = await import('pdf-lib')
  const doc = await PDFDocument.load(await blob.arrayBuffer())
  const bytes = await doc.save({ useObjectStreams: true })
  const out = new Blob([new Uint8Array(bytes)], { type: 'application/pdf' })
  return out.size < blob.size ? out : null
}
