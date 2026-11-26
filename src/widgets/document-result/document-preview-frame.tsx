/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Trans, useLingui } from '@lingui/react/macro'
import { ContentViewHeader } from '@/content-view/header'
import { Button } from '@/components/ui/button'
import { Download, Loader2 } from 'lucide-react'
import type { ReactNode } from 'react'
import type { DocumentBlobState } from './use-document-blob'
import { useDocumentPreviewFrameState } from './use-document-preview-frame-state'

type ReadyState = Extract<DocumentBlobState, { status: 'ready' }>

type DocumentPreviewFrameProps = {
  fileName: string
  state: DocumentBlobState
  /** The preview itself, once the file is loaded. */
  children: (state: ReadyState) => ReactNode
}

/**
 * The chrome shared by every file preview in the side view: the header with Download and Close, and the loading
 * and error states. Download works no matter what the preview inside does with the file. It saves through the app's
 * `downloadFile`, not an anchor at the preview's `blob:` URL, which saves nothing on Android or in the desktop app
 * and misses iOS's Documents folder; a failed save says why.
 */
export const DocumentPreviewFrame = ({ fileName, state, children }: DocumentPreviewFrameProps) => {
  const { t } = useLingui()
  const { canDownload, saveError, close, handleKeyDown, handleDownload } = useDocumentPreviewFrameState(fileName, state)

  const downloadAction = (
    <Button
      onClick={() => void handleDownload()}
      disabled={!canDownload}
      variant="ghost"
      size="icon"
      className="h-8 w-8 rounded-full"
    >
      <Download className="size-4" />
      <span className="sr-only">
        <Trans>Download</Trans>
      </span>
    </Button>
  )

  return (
    // Escape from anywhere in the panel but the sandboxed frame, whose keys never reach this page. As a side panel, it
    // clears the status bar of a phone in landscape, as the other side panel views do.
    <div className="flex h-full flex-col md:pt-[var(--safe-area-top-padding)]" onKeyDown={handleKeyDown}>
      <ContentViewHeader title={fileName} onClose={close} actions={downloadAction} />

      {saveError && (
        <p role="alert" className="shrink-0 border-b border-border px-3 py-2 text-sm text-destructive">
          {t`Couldn't save: ${saveError}`}
        </p>
      )}

      {state.status === 'loading' && (
        <div className="flex flex-1 items-center justify-center">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      )}

      {state.status === 'error' && (
        <div className="flex flex-1 items-center justify-center">
          <p className="text-sm text-destructive">{state.message}</p>
        </div>
      )}

      {state.status === 'ready' && children(state)}
    </div>
  )
}
