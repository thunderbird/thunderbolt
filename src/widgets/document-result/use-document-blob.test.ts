/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import '@/testing-library'

import type { HttpClient } from '@/contexts'
import { createClient } from '@/lib/http'
import { getClock } from '@/testing-library'
import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import { act, cleanup, renderHook } from '@testing-library/react'
import * as docxSnapshot from './docx-snapshot'
import type { DocumentSnapshot } from './snapshot'
import { useDocumentBlob } from './use-document-blob'

/** Use the real client with a local response so preview tests never access the network. */
const makeHttpClient = (resolve: { blob?: Blob; error?: Error }): HttpClient =>
  createClient({
    prefixUrl: 'https://document.test',
    fetch: async () => {
      if (resolve.error) {
        throw resolve.error
      }
      return new Response(resolve.blob)
    },
  })

/** What the renderer resolves to in these tests: one page of markup. */
const pages: DocumentSnapshot = { kind: 'pages', html: '<p>Document preview</p>', width: 854 }

/** Flushes the hook's async fetch + reducer dispatch. */
const flush = async () => {
  await act(async () => {
    await getClock().runAllAsync()
  })
}

describe('useDocumentBlob', () => {
  let revokeSpy: ReturnType<typeof spyOn>

  beforeEach(() => {
    revokeSpy = spyOn(URL, 'revokeObjectURL')
  })

  afterEach(() => {
    cleanup()
    revokeSpy.mockRestore()
  })

  it('starts in the loading state', () => {
    const httpClient = makeHttpClient({ blob: new Blob(['pdf']) })
    const { result } = renderHook(() => useDocumentBlob('file-1', 'pdf', httpClient))
    expect(result.current.status).toBe('loading')
  })

  it('resolves a PDF to a ready state with a blob url and no DOCX pages', async () => {
    const httpClient = makeHttpClient({ blob: new Blob(['pdf']) })
    const { result } = renderHook(() => useDocumentBlob('file-1', 'pdf', httpClient))

    await flush()
    if (result.current.status !== 'ready') {
      throw new Error(`expected ready state, got ${result.current.status}`)
    }
    expect(result.current.blobUrl).toMatch(/^blob:/)
    expect(result.current.snapshot).toBeNull()
  })

  it('resolves an unsupported file to ready (download still works) without DOCX pages', async () => {
    const httpClient = makeHttpClient({ blob: new Blob(['raw']) })
    const { result } = renderHook(() => useDocumentBlob('file-2', 'unsupported', httpClient))

    await flush()
    if (result.current.status !== 'ready') {
      throw new Error(`expected ready state, got ${result.current.status}`)
    }
    expect(result.current.snapshot).toBeNull()
  })

  it('surfaces the error message when the fetch fails', async () => {
    const httpClient = makeHttpClient({ error: new Error('upstream 401') })
    const { result } = renderHook(() => useDocumentBlob('file-3', 'pdf', httpClient))

    await flush()
    if (result.current.status !== 'error') {
      throw new Error(`expected error state, got ${result.current.status}`)
    }
    expect(result.current.message).toBe('upstream 401')
  })

  it('revokes the created object url on unmount', async () => {
    const httpClient = makeHttpClient({ blob: new Blob(['pdf']) })
    const { result, unmount } = renderHook(() => useDocumentBlob('file-4', 'pdf', httpClient))

    await flush()
    expect(result.current.status).toBe('ready')
    unmount()
    expect(revokeSpy).toHaveBeenCalledTimes(1)
  })

  it('creates a DOCX download URL only after conversion succeeds', async () => {
    const pending = Promise.withResolvers<DocumentSnapshot>()
    const convert = spyOn(docxSnapshot, 'renderDocxSnapshot').mockReturnValue(pending.promise)
    const create = spyOn(URL, 'createObjectURL')
    try {
      const httpClient = makeHttpClient({ blob: new Blob(['docx']) })
      const { result, unmount } = renderHook(() => useDocumentBlob('docx-success', 'docx', httpClient))
      await flush()
      expect(result.current.status).toBe('loading')
      expect(create).not.toHaveBeenCalled()

      await act(async () => pending.resolve(pages))
      await flush()
      expect(result.current).toEqual({
        status: 'ready',
        blob: expect.any(Blob),
        blobUrl: expect.stringMatching(/^blob:/),
        snapshot: pages,
      })
      expect(create).toHaveBeenCalledTimes(1)
      unmount()
      expect(revokeSpy).toHaveBeenCalledTimes(1)
    } finally {
      convert.mockRestore()
      create.mockRestore()
    }
  })

  it('does not retain an object URL when DOCX conversion fails', async () => {
    const convert = spyOn(docxSnapshot, 'renderDocxSnapshot').mockRejectedValue(new Error('Invalid DOCX archive'))
    const create = spyOn(URL, 'createObjectURL')
    try {
      const httpClient = makeHttpClient({ blob: new Blob(['invalid-docx']) })
      const { result } = renderHook(() => useDocumentBlob('docx-failure', 'docx', httpClient))
      await flush()
      expect(result.current).toEqual({ status: 'error', message: 'Invalid DOCX archive' })
      expect(create).not.toHaveBeenCalled()
    } finally {
      convert.mockRestore()
      create.mockRestore()
    }
  })

  it('does not create a URL if the preview unmounts during DOCX conversion', async () => {
    const pending = Promise.withResolvers<DocumentSnapshot>()
    const convert = spyOn(docxSnapshot, 'renderDocxSnapshot').mockReturnValue(pending.promise)
    const create = spyOn(URL, 'createObjectURL')
    try {
      const httpClient = makeHttpClient({ blob: new Blob(['docx']) })
      const { unmount } = renderHook(() => useDocumentBlob('docx-cancelled', 'docx', httpClient))
      await flush()
      unmount()
      await act(async () => pending.resolve(pages))
      await flush()
      expect(create).not.toHaveBeenCalled()
      expect(revokeSpy).not.toHaveBeenCalled()
    } finally {
      convert.mockRestore()
      create.mockRestore()
    }
  })

  it('ignores a previous document conversion after a newer PDF has loaded', async () => {
    const pending = Promise.withResolvers<DocumentSnapshot>()
    const convert = spyOn(docxSnapshot, 'renderDocxSnapshot').mockReturnValue(pending.promise)
    const create = spyOn(URL, 'createObjectURL')
    try {
      const httpClient = makeHttpClient({ blob: new Blob(['document']) })
      const { result, rerender, unmount } = renderHook(
        ({ id, type }: { id: string; type: 'pdf' | 'docx' }) => useDocumentBlob(id, type, httpClient),
        { initialProps: { id: 'old-document', type: 'docx' } },
      )
      await flush()
      rerender({ id: 'new-document', type: 'pdf' })
      await flush()
      const pdfState = result.current
      expect(pdfState.status).toBe('ready')
      await act(async () => pending.resolve(pages))
      await flush()
      expect(result.current).toBe(pdfState)
      expect(create).toHaveBeenCalledTimes(1)
      unmount()
      expect(revokeSpy).toHaveBeenCalledTimes(1)
    } finally {
      convert.mockRestore()
      create.mockRestore()
    }
  })

  it('does not start conversion or allocate a URL when the download finishes after unmount', async () => {
    const pending = Promise.withResolvers<Response>()
    const httpClient = createClient({ prefixUrl: 'https://document.test', fetch: () => pending.promise })
    const convert = spyOn(docxSnapshot, 'renderDocxSnapshot')
    const create = spyOn(URL, 'createObjectURL')
    try {
      const { unmount } = renderHook(() => useDocumentBlob('cancelled-download', 'docx', httpClient))
      unmount()
      await act(async () => pending.resolve(new Response(new Blob(['docx']))))
      await flush()
      expect(convert).not.toHaveBeenCalled()
      expect(create).not.toHaveBeenCalled()
      expect(revokeSpy).not.toHaveBeenCalled()
    } finally {
      convert.mockRestore()
      create.mockRestore()
    }
  })
})
