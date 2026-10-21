/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useQuery } from '@tanstack/react-query'
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
  const { data: renderer } = useQuery({
    queryKey: ['markdown-thumbnail-renderer'],
    queryFn: async () => {
      const [markdown, gfm] = await Promise.all([import('react-markdown'), import('remark-gfm')])
      return { Markdown: markdown.default, remarkGfm: gfm.default }
    },
    enabled: !!text,
    staleTime: Infinity,
    // Native clients can load these bundled modules while offline.
    networkMode: 'always',
    throwOnError: false,
  })
  if (!text || !renderer) {
    return null
  }
  const { Markdown, remarkGfm } = renderer
  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden bg-card">
      <div
        className="prose prose-sm dark:prose-invert w-[480px] origin-top-left p-4 text-foreground"
        style={{ transform: 'scale(var(--thumb-scale, 0.3))' }}
      >
        <Markdown remarkPlugins={[remarkGfm]}>{text}</Markdown>
      </div>
    </div>
  )
}
