/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { StoredFile } from '@/lib/file-blob-storage'
import type { TransformImage } from './index'

/** Cap pages so a huge scan doesn't blast hundreds of images at the model. */
const maxPages = 10

/** Render scale — 2× keeps small text legible for a vision model. */
const renderScale = 2

/**
 * Rasterizes a PDF's pages to PNG data URLs via pdfjs (lazy-imported — heavy).
 * Used by the "convert to images" remediation when a model can't read the
 * native PDF and text extraction is empty (a scan): the rendered pages go to a
 * vision model as image parts. Capped at {@link maxPages} pages.
 */
export const pdfToImages = async (file: StoredFile): Promise<{ images: TransformImage[] }> => {
  const pdfjs = await import('pdfjs-dist')
  // Mirror the viewer's Vite worker-URL pattern so both share one worker build.
  pdfjs.GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).toString()

  const data = await file.blob.arrayBuffer()
  const doc = await pdfjs.getDocument({ data }).promise

  const images: TransformImage[] = []
  const pageCount = Math.min(doc.numPages, maxPages)
  for (let pageNum = 1; pageNum <= pageCount; pageNum++) {
    const page = await doc.getPage(pageNum)
    const viewport = page.getViewport({ scale: renderScale })
    const canvas = document.createElement('canvas')
    canvas.width = viewport.width
    canvas.height = viewport.height
    const canvasContext = canvas.getContext('2d')
    if (!canvasContext) {
      continue
    }
    await page.render({ canvas, canvasContext, viewport }).promise
    images.push({ mimeType: 'image/png', dataUrl: canvas.toDataURL('image/png') })
  }
  await doc.destroy()

  return { images }
}
