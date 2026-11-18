/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useLingui } from '@lingui/react/macro'
import { importWhenReachable } from '@/lib/import-when-reachable'
import type { HttpClient } from '@/contexts'
import { getAttachment } from '@/lib/file-blob-storage'
import { useEffect, useReducer, useRef } from 'react'
import type { DocumentSnapshot } from './snapshot'
import type { FileType } from './file-type'

/** Load lifecycle of a previewable document, modelled as a state machine
 *  so impossible combinations (e.g. "done but no url and no error") can't exist. */
export type DocumentBlobState =
  | { status: 'loading' }
  | { status: 'ready'; blob: Blob; blobUrl: string; snapshot: DocumentSnapshot | null }
  | { status: 'error'; message: string }

type DocumentBlobAction =
  | { type: 'reset' }
  | { type: 'loaded'; blob: Blob; blobUrl: string; snapshot: DocumentSnapshot | null }
  | { type: 'failed'; message: string }

const reducer = (_state: DocumentBlobState, action: DocumentBlobAction): DocumentBlobState => {
  switch (action.type) {
    case 'reset':
      return { status: 'loading' }
    case 'loaded':
      return { status: 'ready', blob: action.blob, blobUrl: action.blobUrl, snapshot: action.snapshot }
    case 'failed':
      return { status: 'error', message: action.message }
  }
}

// Each import starts only once the app's server answers, so a renderer tried while it was down still loads later.
const docxSnapshotModule = importWhenReachable(() => import('./docx-snapshot'))
const pptxSnapshotModule = importWhenReachable(() => import('./pptx-snapshot'))

/** Loads the renderer for a DOCX or a PPTX, each only for its own type, which keeps both out of the entry chunk. */
export const snapshotRenderers = {
  docx: async () => (await docxSnapshotModule()).renderDocxSnapshot,
  pptx: async () => (await pptxSnapshotModule()).renderPptxSnapshot,
}

/** The renderer for the file type, or null when its code does not load, as on a broken network. */
const loadRenderer = async (fileType: keyof typeof snapshotRenderers) => {
  try {
    return await snapshotRenderers[fileType]()
  } catch (error) {
    console.error('[preview] Could not load the renderer', error)
    return null
  }
}

/**
 * Renders a DOCX's pages or a PPTX's slides for its preview; other types skip conversion. A renderer that does not
 * load gives `notLoaded`, so the file stays ready and Download still saves it.
 */
const renderSnapshotIfNeeded = async (blob: Blob, fileType: FileType): Promise<DocumentSnapshot | null> => {
  if (fileType !== 'docx' && fileType !== 'pptx') {
    return null
  }
  const render = await loadRenderer(fileType)
  return render ? render(blob) : { kind: 'notLoaded' }
}

/**
 * Shared blob-preview loader: resolves a Blob via `loadBlob`, exposes the load
 * lifecycle as a state machine, renders a DOCX's pages or a PPTX's slides, and revokes the object URL
 * on cleanup. `cacheKey` drives reloads; `loadBlob` is read through a ref so its
 * identity changing on every render doesn't retrigger the effect.
 */
const useBlobDocument = (cacheKey: string, fileType: FileType, loadBlob: () => Promise<Blob>): DocumentBlobState => {
  const { t } = useLingui()
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
      const snapshot = await renderSnapshotIfNeeded(blob, fileType)
      if (cancelled) {
        return
      }
      objectUrl = URL.createObjectURL(blob)
      dispatch({ type: 'loaded', blob, blobUrl: objectUrl, snapshot })
    }

    load().catch((err) => {
      if (!cancelled) {
        dispatch({ type: 'failed', message: err instanceof Error ? err.message : t`Failed to load document` })
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
