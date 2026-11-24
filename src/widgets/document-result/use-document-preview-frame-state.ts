/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useSideview } from '@/content-view/context'
import { i18n } from '@/i18n'
import { downloadFile, saveErrorMessage } from '@/lib/download'
import { type KeyboardEvent, useState } from 'react'
import type { DocumentBlobState } from './use-document-blob'

/**
 * State and actions of a file preview's chrome: closing the side view, on Escape too, and saving the loaded file
 * through `downloadFile`, with the reason a save failed.
 */
export const useDocumentPreviewFrameState = (fileName: string, state: DocumentBlobState) => {
  const { opener, closeSideview: close } = useSideview()
  const [saveError, setSaveError] = useState<string | null>(null)
  const blob = state.status === 'ready' ? state.blob : null

  const handleKeyDown = (event: KeyboardEvent) => {
    // On a phone the preview is a dialog, which closes on Escape itself and marks the key as handled.
    if (event.key !== 'Escape' || event.defaultPrevented) {
      return
    }
    close()
    if (opener instanceof HTMLElement) {
      opener.focus()
    }
  }

  const handleDownload = async () => {
    if (!blob) {
      return
    }
    setSaveError(null)
    try {
      await downloadFile({
        name: fileName,
        contents: new Uint8Array(await blob.arrayBuffer()),
        mimeType: blob.type || 'application/octet-stream',
      })
    } catch (error) {
      console.error('[preview] Could not save the file', error)
      setSaveError(i18n._(saveErrorMessage(error instanceof Error ? error : String(error))))
    }
  }

  return { canDownload: blob !== null, saveError, close, handleKeyDown, handleDownload }
}
