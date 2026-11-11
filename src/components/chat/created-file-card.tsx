/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Trans, useLingui } from '@lingui/react/macro'
import { useTransientFlag } from '@/hooks/use-transient-flag'
import { downloadFile } from '@/lib/download'
import { getAttachment } from '@/lib/file-blob-storage'
import type { CreatedFile } from '@/office/office-script-tool'
import { useLocalDocumentBlob } from '@/widgets/document-result/use-document-blob'
import { Check, Download } from 'lucide-react'
import { useState } from 'react'
import { FileCard } from './file-card'

/**
 * The chip for a file the agent created. The bytes live only in the attachment store of the device that ran
 * the script, so a chat opened on another device says the file is not there instead of offering a download.
 */
export const CreatedFileCard = ({ file }: { file: CreatedFile }) => {
  const { t } = useLingui()
  const stored = useLocalDocumentBlob(file.id, 'unsupported')
  const { isSet: isSaved, flag: flagSaved } = useTransientFlag()
  const [saveError, setSaveError] = useState<string | null>(null)

  const handleDownload = async () => {
    setSaveError(null)
    try {
      const attachment = await getAttachment(file.id)
      if (!attachment) {
        throw new Error('The file is no longer on this device')
      }
      await downloadFile({
        name: file.filename,
        contents: new Uint8Array(await attachment.blob.arrayBuffer()),
        mimeType: file.mimeType,
      })
      flagSaved()
    } catch (error) {
      console.error('[office] Could not save the file', error)
      setSaveError(error instanceof Error ? error.message : String(error))
    }
  }

  const { filename } = file
  const downloadLabel = t`Download ${filename}`
  const note =
    stored.status === 'error' ? (
      <Trans>Not available on this device</Trans>
    ) : saveError ? (
      t`Couldn't save: ${saveError}`
    ) : undefined

  return (
    <FileCard
      localFileId={file.id}
      filename={file.filename}
      mimeType={file.mimeType}
      created
      note={note}
      action={
        stored.status === 'ready' && (
          <button
            type="button"
            onClick={() => void handleDownload()}
            aria-label={downloadLabel}
            title={downloadLabel}
            className="cursor-pointer rounded-full border bg-background p-1 text-muted-foreground shadow-sm hover:text-foreground"
          >
            {isSaved ? <Check className="size-3.5" /> : <Download className="size-3.5" />}
          </button>
        )
      }
    />
  )
}
