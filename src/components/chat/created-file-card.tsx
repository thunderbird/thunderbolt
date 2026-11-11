/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Trans, useLingui } from '@lingui/react/macro'
import type { CreatedFile } from '@/office/office-script-tool'
import { Check, Download } from 'lucide-react'
import { FileCard } from './file-card'
import { useCreatedFileCardState } from './use-created-file-card-state'

/**
 * The chip for a file the agent created. The bytes live only in the attachment store of the device that ran
 * the script, so a chat opened on another device says the file is not there instead of offering a download.
 */
export const CreatedFileCard = ({ file }: { file: CreatedFile }) => {
  const { t } = useLingui()
  const { status, isSaved, saveError, download } = useCreatedFileCardState(file)

  const { filename } = file
  const downloadLabel = t`Download ${filename}`
  const note =
    status === 'error' ? (
      <Trans>Not available on this device</Trans>
    ) : saveError ? (
      t`Couldn't save: ${saveError}`
    ) : undefined

  return (
    <FileCard
      localFileId={file.id}
      filename={file.filename}
      mimeType={file.mimeType}
      note={note}
      action={
        status === 'ready' && (
          <button
            type="button"
            onClick={() => void download()}
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
