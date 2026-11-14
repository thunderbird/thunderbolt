/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Trans } from '@lingui/react/macro'
import { ContentViewHeader } from '@/content-view/header'
import { useContentView } from '@/content-view/context'
import { Button } from '@/components/ui/button'
import { Download, Loader2 } from 'lucide-react'
import { type ReactNode, useCallback } from 'react'
import type { DocumentBlobState } from './use-document-blob'

type ReadyState = Extract<DocumentBlobState, { status: 'ready' }>

type DocumentPreviewFrameProps = {
  fileName: string
  state: DocumentBlobState
  /** The preview itself, once the file is loaded. */
  children: (state: ReadyState) => ReactNode
}

/**
 * The chrome shared by every file preview in the side view: the header with Download and Close, and the loading
 * and error states. Download works no matter what the preview inside does with the file.
 */
export const DocumentPreviewFrame = ({ fileName, state, children }: DocumentPreviewFrameProps) => {
  const { close } = useContentView()
  const blobUrl = state.status === 'ready' ? state.blobUrl : null

  const handleDownload = useCallback(() => {
    if (!blobUrl) {
      return
    }
    const a = document.createElement('a')
    a.href = blobUrl
    a.download = fileName
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
  }, [blobUrl, fileName])

  const downloadAction = (
    <Button onClick={handleDownload} disabled={!blobUrl} variant="ghost" size="icon" className="h-8 w-8 rounded-full">
      <Download className="size-4" />
      <span className="sr-only">
        <Trans>Download</Trans>
      </span>
    </Button>
  )

  return (
    <div className="flex h-full flex-col">
      <ContentViewHeader title={fileName} onClose={close} actions={downloadAction} />

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
