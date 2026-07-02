/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { StoredFile } from '@/lib/file-blob-storage'

/**
 * Extracts a PDF's embedded text layer via pdfjs (lazy-imported — pdfjs is
 * heavy and only this path needs it). Pages are joined with a blank line so
 * paragraph boundaries survive into the model context.
 *
 * Scanned / image-only PDFs carry no text layer and yield little or nothing
 * here — OCR (THU-630) is the fallback for those.
 */
export const pdfToText = async (file: StoredFile): Promise<{ text: string }> => {
  const pdfjs = await import('pdfjs-dist')
  // Mirror the viewer's Vite worker-URL pattern so both share one worker build.
  pdfjs.GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).toString()

  const data = await file.blob.arrayBuffer()
  const doc = await pdfjs.getDocument({ data }).promise

  const pages: string[] = []
  for (let pageNum = 1; pageNum <= doc.numPages; pageNum++) {
    const page = await doc.getPage(pageNum)
    const content = await page.getTextContent()
    pages.push(content.items.map((item) => ('str' in item ? item.str : '')).join(' '))
  }
  await doc.destroy()

  return { text: pages.join('\n\n').trim() }
}
