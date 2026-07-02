/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { FileText, X } from 'lucide-react'
import { lazy, Suspense } from 'react'
import { DocxThumbnail } from './docx-thumbnail'
import { ImageThumbnail } from './image-thumbnail'
import { MarkdownThumbnail } from './markdown-thumbnail'
import { docxMimeType, isTextualAttachment, TextSnippet } from './text-snippet'

// react-pdf is heavy — load it only when an attachment card actually renders.
const PdfThumbnail = lazy(() => import('./pdf-thumbnail'))

type FileCardProps = {
  localFileId: string
  filename: string
  mimeType: string
  /** When set, the card is clickable to open the file (sent message in chat). */
  onOpen?: () => void
  /** When set, shows a remove affordance (pending composer attachment). */
  onRemove?: () => void
  /** Non-native delivery mode applied by remediation — shown as a small badge for transparency. */
  deliverAs?: 'text' | 'images'
  /** Alternative delivery modes this file can be resent as (renders a resend control). */
  resendTargets?: readonly ('text' | 'images')[]
  /** Re-deliver this file as the chosen mode and re-run the turn. */
  onResend?: (target: 'text' | 'images') => void
}

/** Human label for a non-native delivery mode. */
const deliverAsLabel: Record<'text' | 'images', string> = {
  text: 'Sent as text',
  images: 'Sent as images',
}

/** Verb label for a resend control option. */
const resendLabel: Record<'text' | 'images', string> = {
  text: 'text',
  images: 'images',
}

/** Short type badge from the file extension, falling back to the mime type. */
const typeBadge = (filename: string, mimeType: string): string => {
  const ext = filename.includes('.') ? filename.split('.').pop()?.toUpperCase() : undefined
  if (ext && ext.length > 0 && ext.length <= 4) {
    return ext
  }
  return mimeType === 'application/pdf' ? 'PDF' : 'FILE'
}

/**
 * Claude-Desktop-style attachment card: a first-page preview thumbnail with a
 * type badge + filename overlaid along the bottom. Used for pending composer
 * attachments (`onRemove`) and for sent attachments in chat (`onOpen`). The
 * thumbnail renderer is lazy-loaded (see {@link PdfThumbnail}).
 */
export const FileCard = ({
  localFileId,
  filename,
  mimeType,
  onOpen,
  onRemove,
  deliverAs,
  resendTargets,
  onResend,
}: FileCardProps) => {
  const ext = filename.split('.').pop()?.toLowerCase()
  const isPdf = mimeType === 'application/pdf'
  const isImage = mimeType.startsWith('image/')
  const isMarkdown = mimeType === 'text/markdown' || ext === 'md' || ext === 'markdown'
  const isDocx = mimeType === docxMimeType
  // Plain text (txt / csv / …) gets the raw mini-page; md and docx get formatted thumbnails.
  const isPlainText = !isPdf && !isImage && !isMarkdown && !isDocx && isTextualAttachment(filename, mimeType)

  const preview = (
    <div className="relative flex h-36 w-28 items-center justify-center overflow-hidden rounded-xl border bg-muted [--thumb-scale:0.2333] sm:h-44 sm:w-36 sm:[--thumb-scale:0.3]">
      {/* Placeholder shown until (and unless) a real preview renders on top. */}
      <FileText className="size-7 text-muted-foreground sm:size-8" aria-hidden="true" />
      {isPdf && (
        <Suspense fallback={null}>
          <PdfThumbnail localFileId={localFileId} />
        </Suspense>
      )}
      {isImage && <ImageThumbnail localFileId={localFileId} alt={filename} />}
      {isMarkdown && <MarkdownThumbnail localFileId={localFileId} />}
      {isDocx && <DocxThumbnail localFileId={localFileId} title={filename} />}
      {isPlainText && <TextSnippet localFileId={localFileId} mimeType={mimeType} />}
      {deliverAs && (
        <span className="absolute left-1.5 top-1.5 rounded bg-black/65 px-1.5 py-px text-[length:var(--font-size-xs)] font-medium text-white">
          {deliverAsLabel[deliverAs]}
        </span>
      )}
      <div className="absolute inset-x-0 bottom-0 flex items-center gap-1.5 bg-gradient-to-t from-black/65 to-transparent px-2 pb-1.5 pt-5">
        <span className="shrink-0 rounded bg-white/90 px-1 py-px text-[length:var(--font-size-xs)] font-semibold text-black">
          {typeBadge(filename, mimeType)}
        </span>
        <span className="min-w-0 truncate text-[length:var(--font-size-xs)] text-white">{filename}</span>
      </div>
    </div>
  )

  return (
    <div className="group relative">
      {onOpen ? (
        <button
          type="button"
          onClick={onOpen}
          title={filename}
          className="cursor-pointer rounded-xl outline-none transition hover:ring-2 hover:ring-ring focus-visible:ring-2 focus-visible:ring-ring"
        >
          {preview}
        </button>
      ) : (
        preview
      )}
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          aria-label={`Remove ${filename}`}
          className="absolute -right-1.5 -top-1.5 cursor-pointer rounded-full border bg-background p-0.5 text-muted-foreground shadow-sm hover:text-foreground"
        >
          <X className="size-3.5" />
        </button>
      )}
      {onResend && resendTargets && resendTargets.length > 0 && (
        <div className="mt-1 flex flex-wrap items-center justify-end gap-1">
          {resendTargets.map((target) => (
            <button
              key={target}
              type="button"
              onClick={() => onResend(target)}
              className="cursor-pointer rounded-md px-1.5 py-0.5 text-[length:var(--font-size-xs)] text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              Resend as {resendLabel[target]}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
