/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { HttpClient } from '@/contexts'
import { getAttachment } from '@/lib/file-blob-storage'
import { useEffect, useReducer, useRef } from 'react'

export type FileType = 'pdf' | 'docx' | 'unsupported'

/** Load lifecycle of a previewable document, modelled as a state machine
 *  so impossible combinations (e.g. "done but no url and no error") can't exist. */
export type DocumentBlobState =
  | { status: 'loading' }
  | { status: 'ready'; blobUrl: string; docxHtml: string | null }
  | { status: 'error'; message: string }

type DocumentBlobAction =
  | { type: 'reset' }
  | { type: 'loaded'; blobUrl: string; docxHtml: string | null }
  | { type: 'failed'; message: string }

const reducer = (_state: DocumentBlobState, action: DocumentBlobAction): DocumentBlobState => {
  switch (action.type) {
    case 'reset':
      return { status: 'loading' }
    case 'loaded':
      return { status: 'ready', blobUrl: action.blobUrl, docxHtml: action.docxHtml }
    case 'failed':
      return { status: 'error', message: action.message }
  }
}

/** Converts a DOCX blob to HTML via a lazily-imported mammoth. PDFs and other
 *  types skip conversion and return null. mammoth stays out of the main bundle
 *  because the import only runs on the DOCX path. */
const convertDocxIfNeeded = async (blob: Blob, fileType: FileType): Promise<string | null> => {
  if (fileType !== 'docx') {
    return null
  }
  const mammoth = await import('mammoth')
  const arrayBuffer = await blob.arrayBuffer()
  const result = await mammoth.convertToHtml({ arrayBuffer })
  return result.value
}

/**
 * Shared blob-preview loader: resolves a Blob via `loadBlob`, exposes the load
 * lifecycle as a state machine, converts DOCX→HTML, and revokes the object URL
 * on cleanup. `cacheKey` drives reloads; `loadBlob` is read through a ref so its
 * identity changing on every render doesn't retrigger the effect.
 */
const useBlobDocument = (cacheKey: string, fileType: FileType, loadBlob: () => Promise<Blob>): DocumentBlobState => {
  const [state, dispatch] = useReducer(reducer, { status: 'loading' })
  const loadBlobRef = useRef(loadBlob)
  loadBlobRef.current = loadBlob

  useEffect(() => {
    let cancelled = false
    let objectUrl: string | null = null
    dispatch({ type: 'reset' })

    const load = async () => {
      const blob = await loadBlobRef.current()
      if (cancelled) {
        return
      }
      objectUrl = URL.createObjectURL(blob)
      const docxHtml = await convertDocxIfNeeded(blob, fileType)
      if (cancelled) {
        URL.revokeObjectURL(objectUrl)
        objectUrl = null
        return
      }
      dispatch({ type: 'loaded', blobUrl: objectUrl, docxHtml })
    }

    load().catch((err) => {
      if (!cancelled) {
        dispatch({ type: 'failed', message: err instanceof Error ? err.message : 'Failed to load document' })
      }
    })

    return () => {
      cancelled = true
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl)
      }
    }
    // loadBlob is read via ref; cacheKey + fileType drive reloads.
  }, [cacheKey, fileType])

  return state
}

/** Fetch a Haystack-managed document (by file id) as a previewable blob via the backend. */
export const useDocumentBlob = (fileId: string, fileType: FileType, httpClient: HttpClient): DocumentBlobState =>
  useBlobDocument(`haystack:${fileId}`, fileType, async () => {
    const response = await httpClient.get(`haystack/files/${fileId}`)
    return response.blob()
  })

/** Load a locally-uploaded attachment (by local id) from IndexedDB as a previewable blob. */
export const useLocalDocumentBlob = (localFileId: string, fileType: FileType): DocumentBlobState =>
  useBlobDocument(`local:${localFileId}`, fileType, async () => {
    const file = await getAttachment(localFileId)
    if (!file) {
      throw new Error('This attachment isn’t available on this device.')
    }
    return file.blob
  })
