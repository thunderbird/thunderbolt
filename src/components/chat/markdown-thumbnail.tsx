/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { useAttachmentText } from './text-snippet'

type MarkdownThumbnailProps = {
  localFileId: string
}

/**
 * Renders a markdown attachment as *formatted* markdown, scaled down into a
 * mini-page thumbnail (rendered at 480px wide, then transform-scaled to the
 * 160px card). Returns null until the text resolves so the placeholder shows.
 */
export const MarkdownThumbnail = ({ localFileId }: MarkdownThumbnailProps) => {
  const text = useAttachmentText(localFileId, 'text/markdown')
  if (!text) {
    return null
  }
  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden bg-card">
      <div
        className="prose prose-sm dark:prose-invert w-[480px] origin-top-left p-4 text-foreground"
        style={{ transform: 'scale(var(--thumb-scale, 0.3))' }}
      >
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
      </div>
    </div>
  )
}
