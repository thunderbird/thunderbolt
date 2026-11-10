/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { StoredFile } from '@/lib/file-blob-storage'
import { describe, expect, it, mock, spyOn } from 'bun:test'
import * as pdfjs from 'pdfjs-dist'
import { pdfToText } from './pdf-to-text'

const file: StoredFile = {
  id: 'pdf-text',
  filename: 'document.pdf',
  mimeType: 'application/pdf',
  size: 3,
  createdAt: 0,
  blob: new Blob(['pdf']),
}

describe('pdfToText resource lifecycle', () => {
  it('preserves page text and releases the loading task after success', async () => {
    const destroy = mock(async () => {})
    const getPage = mock(async (pageNumber: number) => ({
      getTextContent: async () => ({ items: [{ str: `Page ${pageNumber}` }, { type: 'endMarkedContent' }] }),
    }))
    const task = {
      promise: Promise.resolve({ numPages: 2, getPage }),
      destroy,
    } as unknown as pdfjs.PDFDocumentLoadingTask
    const getDocument = spyOn(pdfjs, 'getDocument').mockReturnValue(task)
    try {
      expect(await pdfToText(file)).toEqual({ text: 'Page 1 \n\nPage 2' })
      expect(getPage.mock.calls).toEqual([[1], [2]])
      expect(destroy).toHaveBeenCalledTimes(1)
    } finally {
      getDocument.mockRestore()
    }
  })

  it.each(['load', 'page', 'text'] as const)(
    'releases the loading task when %s fails without replacing the error',
    async (failure) => {
      const error = new Error(`${failure} failed`)
      const destroy = mock(async () => {})
      const getPage = async () => {
        if (failure === 'page') {
          throw error
        }
        return {
          getTextContent: async () => {
            throw error
          },
        }
      }
      const task = {
        get promise() {
          return failure === 'load' ? Promise.reject(error) : Promise.resolve({ numPages: 1, getPage })
        },
        destroy,
      } as unknown as pdfjs.PDFDocumentLoadingTask
      const getDocument = spyOn(pdfjs, 'getDocument').mockReturnValue(task)
      try {
        await expect(pdfToText(file)).rejects.toBe(error)
        expect(destroy).toHaveBeenCalledTimes(1)
      } finally {
        getDocument.mockRestore()
      }
    },
  )
})
