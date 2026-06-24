/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { cn } from '@/lib/utils'
import { FileText, X } from 'lucide-react'

type FileChipProps = {
  filename: string
  /** When set, the chip is clickable to open the file (e.g. in the side viewer). */
  onOpen?: () => void
  /** When set, shows a remove affordance (used for pending composer attachments). */
  onRemove?: () => void
}

/**
 * Inline file pill used both for pending composer attachments (with `onRemove`)
 * and for sent attachments in a message (with `onOpen`).
 */
export const FileChip = ({ filename, onOpen, onRemove }: FileChipProps) => (
  <span className="inline-flex max-w-56 items-center gap-1.5 rounded-lg border bg-muted px-2 py-1 text-[length:var(--font-size-xs)]">
    <FileText className="size-[var(--icon-size-sm)] shrink-0 text-muted-foreground" aria-hidden="true" />
    <button
      type="button"
      onClick={onOpen}
      disabled={!onOpen}
      title={filename}
      className={cn(
        'min-w-0 truncate text-left text-foreground',
        onOpen ? 'cursor-pointer hover:underline' : 'cursor-default',
      )}
    >
      {filename}
    </button>
    {onRemove && (
      <button
        type="button"
        onClick={onRemove}
        aria-label={`Remove ${filename}`}
        className="shrink-0 cursor-pointer rounded-sm p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
      >
        <X className="size-[var(--icon-size-sm)]" />
      </button>
    )}
  </span>
)
