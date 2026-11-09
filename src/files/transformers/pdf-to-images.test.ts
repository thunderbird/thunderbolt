/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { StoredFile } from '@/lib/file-blob-storage'
import { describe, expect, it, mock, spyOn } from 'bun:test'
import * as pdfjs from 'pdfjs-dist'
import { pdfToImages } from './pdf-to-images'

const file: StoredFile = {
  id: 'pdf-images',
  filename: 'document.pdf',
  mimeType: 'application/pdf',
  size: 3,
  createdAt: 0,
  blob: new Blob(['pdf']),
}

describe('pdfToImages resource lifecycle', () => {
  it('releases the loading task even when the browser cannot create a canvas context', async () => {
    const destroy = mock(async () => {})
    const render = mock()
    const getDocument = spyOn(pdfjs, 'getDocument').mockReturnValue({
      promise: Promise.resolve({
        numPages: 1,
        getPage: async () => ({ getViewport: () => ({ width: 100, height: 200 }), render }),
      }),
      destroy,
    } as unknown as pdfjs.PDFDocumentLoadingTask)
    const context = spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
    try {
      expect(await pdfToImages(file)).toEqual({ images: [] })
      expect(render).not.toHaveBeenCalled()
      expect(destroy).toHaveBeenCalledTimes(1)
    } finally {
      getDocument.mockRestore()
      context.mockRestore()
    }
  })

  it('keeps the ten-page limit and releases the loading task after rendering', async () => {
    const destroy = mock(async () => {})
    const getPage = mock(async () => ({
      getViewport: () => ({ width: 100, height: 200 }),
      render: () => ({ promise: Promise.resolve() }),
    }))
    const task = {
      promise: Promise.resolve({ numPages: 12, getPage }),
      destroy,
    } as unknown as pdfjs.PDFDocumentLoadingTask
    const getDocument = spyOn(pdfjs, 'getDocument').mockReturnValue(task)
    const context = spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({} as CanvasRenderingContext2D)
    const dataUrl = spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/png;base64,png')
    try {
      const result = await pdfToImages(file)
      expect(result.images).toEqual(
        Array.from({ length: 10 }, () => ({ mimeType: 'image/png', dataUrl: 'data:image/png;base64,png' })),
      )
      expect(getPage).toHaveBeenCalledTimes(10)
      expect(destroy).toHaveBeenCalledTimes(1)
    } finally {
      getDocument.mockRestore()
      context.mockRestore()
      dataUrl.mockRestore()
    }
  })

  it.each(['load', 'page', 'render', 'encode'] as const)(
    'releases the loading task when %s fails without replacing the error',
    async (failure) => {
      const error = new Error(`${failure} failed`)
      const destroy = mock(async () => {})
      const getPage = async () => {
        if (failure === 'page') {
          throw error
        }
        return {
          getViewport: () => ({ width: 100, height: 200 }),
          render: () => ({ promise: failure === 'render' ? Promise.reject(error) : Promise.resolve() }),
        }
      }
      const task = {
        get promise() {
          return failure === 'load' ? Promise.reject(error) : Promise.resolve({ numPages: 1, getPage })
        },
        destroy,
      } as unknown as pdfjs.PDFDocumentLoadingTask
      const getDocument = spyOn(pdfjs, 'getDocument').mockReturnValue(task)
      const context = spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({} as CanvasRenderingContext2D)
      const dataUrl = spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockImplementation(() => {
        throw error
      })
      try {
        await expect(pdfToImages(file)).rejects.toBe(error)
        expect(destroy).toHaveBeenCalledTimes(1)
      } finally {
        getDocument.mockRestore()
        context.mockRestore()
        dataUrl.mockRestore()
      }
    },
  )
})
