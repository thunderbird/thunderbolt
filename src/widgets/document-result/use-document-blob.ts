/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { HttpClient } from '@/contexts'
import { useEffect, useReducer } from 'react'

export type FileType = 'pdf' | 'docx' | 'unsupported'

/** Load lifecycle of a Haystack-managed document, modelled as a state machine
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
 * Fetches a Haystack-managed document as a blob and exposes its load lifecycle
 * as a discriminated-union state machine. DOCX files are converted to HTML;
 * PDFs and unsupported types expose only the object URL (for react-pdf rendering
 * and downloads respectively).
 *
 * The created object URL is revoked on unmount and whenever `fileId`/`fileType`
 * changes, so callers never manage blob cleanup themselves.
 */
export const useDocumentBlob = (fileId: string, fileType: FileType, httpClient: HttpClient): DocumentBlobState => {
  const [state, dispatch] = useReducer(reducer, { status: 'loading' })

  useEffect(() => {
    let cancelled = false
    let objectUrl: string | null = null
    dispatch({ type: 'reset' })

    const load = async () => {
      const response = await httpClient.get(`haystack/files/${fileId}`)
      const blob = await response.blob()
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
      if (cancelled) {
        return
      }
      dispatch({ type: 'failed', message: err instanceof Error ? err.message : 'Failed to load document' })
    })

    return () => {
      cancelled = true
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl)
      }
    }
  }, [fileId, fileType, httpClient])

  return state
}
