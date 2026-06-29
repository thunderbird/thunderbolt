/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { cn } from '@/lib/utils'
import { FileText, FileType2, Image as ImageIcon, X } from 'lucide-react'
import type { ComponentType } from 'react'

type AttachmentCardProps = {
  filename: string
  mimeType: string
  /** Sent-message card: clickable to open the file in the side viewer. */
  onOpen?: () => void
  /** Composer pending card: shows a remove affordance. */
  onRemove?: () => void
}

const getFileIcon = (filename: string, mimeType: string): ComponentType<{ className?: string }> => {
  if (mimeType.startsWith('image/')) {
    return ImageIcon
  }
  return filename.split('.').pop()?.toLowerCase() === 'pdf' ? FileType2 : FileText
}

/** Short type label shown under the filename, e.g. "PDF", "DOCX", "Image". */
const typeLabel = (filename: string, mimeType: string): string => {
  if (mimeType.startsWith('image/')) {
    return 'Image'
  }
  const ext = filename.split('.').pop()?.toUpperCase()
  return ext && ext.length <= 4 ? ext : 'File'
}

const cardBase = 'flex w-60 max-w-full items-center gap-3 rounded-lg border border-border bg-card p-3 shadow-sm'

/**
 * Rich card for a file attachment — file-type icon + filename + type label.
 * Used everywhere attachments render: the composer's pending list (with
 * `onRemove`) and inside sent messages (with `onOpen`, clickable to open the
 * local file in the side viewer). Mirrors the `document-result` widget card.
 */
export const AttachmentCard = ({ filename, mimeType, onOpen, onRemove }: AttachmentCardProps) => {
  const Icon = getFileIcon(filename, mimeType)
  const body = (
    <>
      <div className="flex size-10 shrink-0 items-center justify-center rounded-md bg-muted">
        <Icon className="size-[var(--icon-size-default)] text-muted-foreground" />
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-[length:var(--font-size-sm)] font-medium text-foreground">{filename}</p>
        <p className="text-[length:var(--font-size-xs)] text-muted-foreground">{typeLabel(filename, mimeType)}</p>
      </div>
    </>
  )

  // Composer pending: a remove button lives inside, so the card itself isn't a
  // button (avoids nesting buttons).
  if (onRemove) {
    return (
      <div className={cardBase} title={filename}>
        {body}
        <button
          type="button"
          onClick={onRemove}
          aria-label={`Remove ${filename}`}
          className="shrink-0 cursor-pointer rounded-sm p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <X className="size-[var(--icon-size-sm)]" />
        </button>
      </div>
    )
  }

  // Sent message: the whole card is the click target to open the viewer.
  return (
    <button
      type="button"
      onClick={onOpen}
      disabled={!onOpen}
      title={filename}
      className={cn(
        cardBase,
        'text-left transition-colors',
        onOpen ? 'cursor-pointer hover:bg-accent' : 'cursor-default',
      )}
    >
      {body}
    </button>
  )
}
