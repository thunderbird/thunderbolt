/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useTransientFlag } from '@/hooks/use-transient-flag'
import { downloadFile } from '@/lib/download'
import { getAttachment, type StoredFile } from '@/lib/file-blob-storage'
import type { CreatedFile } from '@/office/office-script-tool'
import { useEffect, useState } from 'react'

type StoredState = { status: 'loading' } | { status: 'ready'; file: StoredFile } | { status: 'error' }

/**
 * State and the download action of a created-file chip. The tool result only points at the file: any agent can
 * write one, so the name, type and bytes shown and saved come from this device's store, and the result's own name
 * is shown only where the store has no copy.
 */
export const useCreatedFileCardState = (file: CreatedFile) => {
  const [stored, setStored] = useState<StoredState>({ status: 'loading' })
  const { isSet: isSaved, flag: flagSaved } = useTransientFlag()
  const [saveError, setSaveError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      const record = await getAttachment(file.id)
      if (!cancelled) {
        setStored(record ? { status: 'ready', file: record } : { status: 'error' })
      }
    }
    load().catch((error) => {
      console.error('[office] Could not read the created file', error)
      if (!cancelled) {
        setStored({ status: 'error' })
      }
    })
    return () => {
      cancelled = true
    }
  }, [file.id])

  const shown = stored.status === 'ready' ? stored.file : file

  const download = async () => {
    if (stored.status !== 'ready') {
      return
    }
    setSaveError(null)
    try {
      await downloadFile({
        name: stored.file.filename,
        contents: new Uint8Array(await stored.file.blob.arrayBuffer()),
        mimeType: stored.file.mimeType,
      })
      flagSaved()
    } catch (error) {
      console.error('[office] Could not save the file', error)
      setSaveError(error instanceof Error ? error.message : String(error))
    }
  }

  /** `error` means the bytes are not on this device. */
  return { status: stored.status, filename: shown.filename, mimeType: shown.mimeType, isSaved, saveError, download }
}
