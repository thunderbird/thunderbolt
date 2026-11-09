/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { cn } from '@/lib/utils'
import { useLingui } from '@lingui/react/macro'
import { AlertCircle, Check, Loader2, X } from 'lucide-react'
import type { ClipboardEvent, KeyboardEvent } from 'react'
import { isBlockingTag, type ShareRecipientTag } from './use-share-chat-state'

type EmailTagInputProps = {
  tags: ShareRecipientTag[]
  draft: string
  disabled: boolean
  onDraftChange: (draft: string) => void
  /** Commit text as one or more emails. */
  onCommit: (text: string) => void
  onRemove: (email: string) => void
}

const TagStatusIcon = ({ status }: { status: ShareRecipientTag['status'] }) => {
  if (status === 'checking') {
    return <Loader2 className="size-[var(--icon-size-sm)] animate-spin text-muted-foreground" aria-hidden="true" />
  }
  if (status === 'ok') {
    return <Check className="size-[var(--icon-size-sm)] text-primary" aria-hidden="true" />
  }
  return <AlertCircle className="size-[var(--icon-size-sm)] text-destructive" aria-hidden="true" />
}

/**
 * An email field that turns each address into a tag as it is committed — on
 * Enter, comma, space, paste or blur — and shows whether it can be shared with.
 */
export const EmailTagInput = ({ tags, draft, disabled, onDraftChange, onCommit, onRemove }: EmailTagInputProps) => {
  const { t } = useLingui()
  const hasError = tags.some(isBlockingTag)

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (['Enter', ',', ' ', ';', 'Tab'].includes(event.key) && draft.trim()) {
      event.preventDefault()
      onCommit(draft)
      return
    }
    const lastTag = tags.at(-1)
    if (event.key === 'Backspace' && !draft && lastTag) {
      onRemove(lastTag.email)
    }
  }

  const handlePaste = (event: ClipboardEvent<HTMLInputElement>) => {
    const text = event.clipboardData.getData('text')
    if (/[\s,;]/.test(text.trim())) {
      event.preventDefault()
      onCommit(`${draft} ${text}`)
    }
  }

  return (
    // Styled as the app's `Input`, and tagged `data-slot="input"` so modals give
    // it the same card fill they give every other field.
    <div
      data-slot="input"
      className={cn(
        'flex min-h-[var(--touch-height-default)] w-full flex-wrap items-center gap-1.5 rounded-lg border border-border bg-transparent px-2 py-1.5 text-left focus-within:border-border-strong dark:bg-input',
        hasError && 'border-destructive focus-within:border-destructive',
        disabled && 'pointer-events-none opacity-50',
      )}
    >
      {tags.map((tag) => (
        <span
          key={tag.email}
          data-testid="share-recipient-tag"
          data-status={tag.status}
          className={cn(
            'inline-flex max-w-full items-center gap-1 rounded-md border px-2 py-0.5 text-[length:var(--font-size-sm)]',
            tag.status === 'ok' && 'border-border bg-muted',
            isBlockingTag(tag) && 'border-destructive/50 bg-destructive/10',
            tag.status === 'checking' && 'border-border bg-muted/50',
          )}
        >
          <TagStatusIcon status={tag.status} />
          <span className="truncate">{tag.email}</span>
          <button
            type="button"
            onClick={() => onRemove(tag.email)}
            disabled={disabled}
            aria-label={t`Remove ${tag.email}`}
            className="cursor-pointer rounded-sm text-muted-foreground hover:text-foreground"
          >
            <X className="size-[var(--icon-size-sm)]" />
          </button>
        </span>
      ))}
      <input
        type="email"
        value={draft}
        disabled={disabled}
        onChange={(event) => onDraftChange(event.target.value)}
        onKeyDown={handleKeyDown}
        onPaste={handlePaste}
        onBlur={() => draft.trim() && onCommit(draft)}
        placeholder={tags.length === 0 ? t`Add people by email` : ''}
        aria-label={t`Email addresses`}
        className="min-w-32 flex-1 bg-transparent px-1 text-[length:var(--font-size-body)] outline-none placeholder:text-muted-foreground"
      />
    </div>
  )
}
