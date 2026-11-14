/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { getAttachment } from '@/lib/file-blob-storage'
import { useEffect, useState } from 'react'

/** Plain-text-ish extensions that may arrive with an empty/odd MIME type. */
const textualExtensions = ['txt', 'md', 'markdown', 'csv', 'log', 'json']

/** True if we can render a text preview for this attachment. */
export const isTextualAttachment = (filename: string, mimeType: string): boolean => {
  if (mimeType.startsWith('text/')) {
    return true
  }
  const ext = filename.split('.').pop()?.toLowerCase()
  return !!ext && textualExtensions.includes(ext)
}

/** Enough to fill the small card; we never render the whole document. */
const maxPreviewChars = 1500

/** Loads a short head of an attachment's text. Returns null until it resolves;
 *  best-effort (null on failure). */
export const useAttachmentText = (localFileId: string): string | null => {
  const [text, setText] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    const load = async () => {
      try {
        const file = await getAttachment(localFileId)
        if (!file || cancelled) {
          return
        }
        // Only the head of the file, not the whole thing.
        const extracted = await file.blob.slice(0, 8192).text()
        if (!cancelled) {
          setText(extracted.slice(0, maxPreviewChars))
        }
      } catch {
        // Preview is best-effort; leave the placeholder on failure.
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [localFileId])
  return text
}

type TextSnippetProps = {
  localFileId: string
}

/**
 * Fills an attachment card with a faded mini-page of the document's raw text —
 * the "Quick Look" preview for plain formats (txt / csv). Markdown and docx get
 * their own *formatted* thumbnails; see MarkdownThumbnail / DocxThumbnail.
 */
export const TextSnippet = ({ localFileId }: TextSnippetProps) => {
  const text = useAttachmentText(localFileId)
  if (!text) {
    return null
  }
  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden bg-card px-2.5 pt-2.5">
      <p className="whitespace-pre-wrap break-words font-mono text-[9px] leading-[1.35] text-muted-foreground">
        {text}
      </p>
    </div>
  )
}
