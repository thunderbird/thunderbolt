/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { maybeCompressAttachment } from '@/files/compress/compress-attachment'
import { resolveTextMimeType } from '@/files/transformers'
import * as fileBlobStorage from '@/lib/file-blob-storage'
import type { AttachmentData } from '@/types'
import { useLingui } from '@lingui/react/macro'
import { useCallback, useState } from 'react'

/** Max size for a chat attachment stored locally and sent to the agent. */
const maxAttachmentBytes = 25 * 1024 * 1024
const maxAttachmentCount = 10

/** Mime types accepted as attachments. PDFs and images deliver natively to
 *  capable models; plain-text types (txt / md / csv / json) and xlsx deliver as
 *  text; docx (and a native file a model rejects) auto-remediate to text/images. */
const acceptedAttachmentMimeTypes = new Set([
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'text/markdown',
  'text/plain',
  'text/csv',
  'application/json',
])

/** Extension fallback for when the browser reports an empty/odd mime type
 *  (common for .md). */
const acceptedAttachmentExtensions = [
  '.pdf',
  '.png',
  '.jpg',
  '.jpeg',
  '.webp',
  '.gif',
  '.docx',
  '.xlsx',
  '.md',
  '.markdown',
  '.txt',
  '.csv',
  '.json',
]

/** `accept` attribute string for the file picker. */
export const attachmentAcceptAttr = [...acceptedAttachmentMimeTypes, ...acceptedAttachmentExtensions].join(',')

const isAcceptedAttachment = (file: File): boolean =>
  acceptedAttachmentMimeTypes.has(file.type) ||
  acceptedAttachmentExtensions.some((ext) => file.name.toLowerCase().endsWith(ext))

/**
 * Normalize a file's MIME before it is stored.
 *
 * Load-bearing, not cosmetic: a `.md` commonly arrives with an **empty** `type`,
 * and `defaultDeliveryMode('')` routes an attachment as *native bytes* — which a
 * model can't read. Resolving to `text/plain` here makes it deliver as text.
 */
const attachmentMimeType = (file: File): string => resolveTextMimeType(file.name, file.type)

/** Clipboard files (e.g. a pasted screenshot) often arrive with an empty name.
 *  Give them a stable, extension-bearing filename so the chip renders and the
 *  extension-based accept check has something to work with. */
const withClipboardFilename = (file: File, index: number): File => {
  if (file.name) {
    return file
  }
  const ext = file.type.split('/')[1] ?? 'png'
  return new File([file], `pasted-image-${Date.now()}-${index}.${ext}`, { type: file.type })
}

/** Where queued attachments' bytes are written. */
export type AttachmentStorage = Pick<typeof fileBlobStorage, 'putAttachment' | 'deleteAttachment'>

/**
 * The attachments queued in a composer before a send: adding files (picked,
 * dropped or pasted) checks, compresses and stores each one locally, and the
 * composer gets back reference-only `AttachmentData`. Shared by the chat
 * composer and Quick Entry, so a pasted image behaves the same in both.
 *
 * `acceptsAttachments` false lets a paste fall through as text. `storage`
 * defaults to the IndexedDB blob store; tests pass an in-memory one.
 */
export const useComposerAttachments = ({
  acceptsAttachments,
  storage = fileBlobStorage,
}: {
  acceptsAttachments: boolean
  storage?: AttachmentStorage
}) => {
  const { t } = useLingui()
  const [attachments, setAttachments] = useState<AttachmentData[]>([])
  const [attachError, setAttachError] = useState<string | null>(null)

  // Store dropped/picked PDFs locally (IndexedDB) and add reference-only
  // attachments. Bytes never enter a message part — only the localFileId ref.
  const addFiles = useCallback(
    async (files: File[]) => {
      setAttachError(null)
      // `count` tracks the running total as we add through the loop, since
      // `setAttachments` won't have flushed mid-iteration.
      let count = attachments.length
      for (const file of files) {
        if (count >= maxAttachmentCount) {
          setAttachError(t`You can attach up to ${maxAttachmentCount} files.`)
          break
        }
        if (!isAcceptedAttachment(file)) {
          const filename = file.name
          setAttachError(t`"${filename}" isn't a supported file type.`)
          continue
        }
        // Shrink large images/PDFs before the cap check, so a compressible
        // photo over the limit can slip under it instead of being rejected.
        // Falls back to the original when it can't help.
        const prepared = await maybeCompressAttachment(file)
        if (prepared.size > maxAttachmentBytes) {
          const maxMegabytes = maxAttachmentBytes / 1024 / 1024
          const filename = prepared.name
          setAttachError(t`"${filename}" is too large (max ${maxMegabytes}MB).`)
          continue
        }
        const localFileId = crypto.randomUUID()
        try {
          await storage.putAttachment({
            id: localFileId,
            filename: prepared.name,
            mimeType: attachmentMimeType(prepared),
            size: prepared.size,
            createdAt: Date.now(),
            blob: prepared,
          })
        } catch (error) {
          // IndexedDB can reject when its storage quota is exceeded or it's
          // unavailable. Surface it instead of letting the `void`-called
          // promise reject silently — otherwise no chip appears and no banner
          // shows. Stop here: subsequent writes would hit the same failure.
          console.error('Failed to store attachment locally:', error)
          const filename = prepared.name
          setAttachError(t`Couldn't attach "${filename}" — your browser's storage is full or unavailable.`)
          break
        }
        setAttachments((prev) => [
          ...prev,
          { localFileId, filename: prepared.name, mimeType: attachmentMimeType(prepared) },
        ])
        count++
      }
    },
    [attachments.length, t, storage],
  )

  // Intercept clipboard paste (Cmd/Ctrl+V) so copied files and pasted images
  // become attachments — the same path as drag-drop and the paperclip. Only
  // preventDefault when the clipboard actually carries files, so a normal text
  // paste falls through untouched. Returns the pending add when it took the
  // paste, so a caller can hold a send until the files are stored.
  const handlePaste = useCallback(
    // Structural, so a native `paste` event (Quick Entry listens on its window) works as well as React's.
    (e: Pick<ClipboardEvent, 'clipboardData' | 'preventDefault'>) => {
      const files = Array.from(e.clipboardData?.items ?? [])
        .filter((item) => item.kind === 'file')
        .map((item) => item.getAsFile())
        .filter((file): file is File => file != null)
      // An agent that takes no attachments lets the paste fall through untouched.
      if (!acceptsAttachments || files.length === 0) {
        return
      }
      e.preventDefault()
      return addFiles(files.map(withClipboardFilename))
    },
    [acceptsAttachments, addFiles],
  )

  const removeAttachment = useCallback(
    (localFileId: string) => {
      setAttachments((prev) => prev.filter((a) => a.localFileId !== localFileId))
      storage.deleteAttachment(localFileId).catch((error) => console.error('Failed to delete local attachment:', error))
    },
    [storage],
  )

  return { attachments, setAttachments, attachError, setAttachError, addFiles, handlePaste, removeAttachment }
}
