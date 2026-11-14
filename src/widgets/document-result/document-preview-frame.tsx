/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Trans, useLingui } from '@lingui/react/macro'
import { ContentViewHeader } from '@/content-view/header'
import { useContentView } from '@/content-view/context'
import { Button } from '@/components/ui/button'
import { downloadFile } from '@/lib/download'
import { Download, Loader2 } from 'lucide-react'
import { type ReactNode, useState } from 'react'
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
 * and error states. Download works no matter what the preview inside does with the file. It saves through the app's
 * `downloadFile`, not an anchor at the preview's `blob:` URL, which saves nothing on Android or in the desktop app
 * and misses iOS's Documents folder; a failed save says why.
 */
export const DocumentPreviewFrame = ({ fileName, state, children }: DocumentPreviewFrameProps) => {
  const { t } = useLingui()
  const { close } = useContentView()
  const [saveError, setSaveError] = useState<string | null>(null)
  const blob = state.status === 'ready' ? state.blob : null

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
      setSaveError(error instanceof Error ? error.message : String(error))
    }
  }

  const downloadAction = (
    <Button
      onClick={() => void handleDownload()}
      disabled={!blob}
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
    <div className="flex h-full flex-col">
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
