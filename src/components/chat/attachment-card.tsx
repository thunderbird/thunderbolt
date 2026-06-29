/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { cn } from '@/lib/utils'
import { FileText, FileType2, Image as ImageIcon } from 'lucide-react'
import type { ComponentType } from 'react'

type AttachmentCardProps = {
  filename: string
  mimeType: string
  /** When set, the card is clickable to open the file in the side viewer. */
  onOpen?: () => void
}

const getFileIcon = (filename: string, mimeType: string): ComponentType<{ className?: string }> => {
  if (mimeType.startsWith('image/')) {
    return ImageIcon
  }
  const ext = filename.split('.').pop()?.toLowerCase()
  return ext === 'pdf' ? FileType2 : FileText
}

/** Short type label shown under the filename, e.g. "PDF", "DOCX", "Image". */
const typeLabel = (filename: string, mimeType: string): string => {
  if (mimeType.startsWith('image/')) {
    return 'Image'
  }
  const ext = filename.split('.').pop()?.toUpperCase()
  return ext && ext.length <= 4 ? ext : 'File'
}

/**
 * Rich card for an attachment shown inside a sent chat message — file-type icon
 * + filename + type label, clickable to open the local file in the side viewer.
 * Mirrors the `document-result` widget card so uploaded files render as nicely
 * as pipeline-returned documents. (The composer's pending attachments keep the
 * compact {@link FileChip} pill with its remove affordance.)
 */
export const AttachmentCard = ({ filename, mimeType, onOpen }: AttachmentCardProps) => {
  const Icon = getFileIcon(filename, mimeType)
  return (
    <button
      type="button"
      onClick={onOpen}
      disabled={!onOpen}
      title={filename}
      className={cn(
        'flex w-60 max-w-full items-center gap-3 rounded-lg border border-border bg-card p-3 text-left shadow-sm transition-colors',
        onOpen ? 'cursor-pointer hover:bg-accent' : 'cursor-default',
      )}
    >
      <div className="flex size-10 shrink-0 items-center justify-center rounded-md bg-muted">
        <Icon className="size-[var(--icon-size-default)] text-muted-foreground" />
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-[length:var(--font-size-sm)] font-medium text-foreground">{filename}</p>
        <p className="text-[length:var(--font-size-xs)] text-muted-foreground">{typeLabel(filename, mimeType)}</p>
      </div>
    </button>
  )
}
