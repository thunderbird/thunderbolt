/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useTransientFlag } from '@/hooks/use-transient-flag'
import { downloadFile } from '@/lib/download'
import { getAttachment } from '@/lib/file-blob-storage'
import type { CreatedFile } from '@/office/office-script-tool'
import { useLocalDocumentBlob } from '@/widgets/document-result/use-document-blob'
import { useState } from 'react'

/** State and the download action of a created-file chip: whether the bytes are on this device, and the save outcome. */
export const useCreatedFileCardState = (file: CreatedFile) => {
  const stored = useLocalDocumentBlob(file.id, 'unsupported')
  const { isSet: isSaved, flag: flagSaved } = useTransientFlag()
  const [saveError, setSaveError] = useState<string | null>(null)

  const download = async () => {
    setSaveError(null)
    try {
      const attachment = await getAttachment(file.id)
      if (!attachment) {
        throw new Error('The file is no longer on this device')
      }
      // The transcript only points at the file: any agent can write a tool result, but the store holds the checked name.
      await downloadFile({
        name: attachment.filename,
        contents: new Uint8Array(await attachment.blob.arrayBuffer()),
        mimeType: attachment.mimeType,
      })
      flagSaved()
    } catch (error) {
      console.error('[office] Could not save the file', error)
      setSaveError(error instanceof Error ? error.message : String(error))
    }
  }

  /** `error` means the bytes are not on this device. */
  return { status: stored.status, isSaved, saveError, download }
}
