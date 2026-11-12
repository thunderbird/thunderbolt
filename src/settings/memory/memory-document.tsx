/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { Components } from 'react-markdown'
import { MemoizedMarkdown } from '@/components/chat/memoized-markdown'
import { markdownComponents } from '@/components/chat/markdown-utils'

// Saved text can include tool output; viewing memory must not fetch embedded image URLs.
const memoryComponents: Components = {
  ...markdownComponents,
  img: ({ alt }) => <span>{alt}</span>,
}

export const MemoryDocument = ({ content }: { content: string }) => (
  <div className="[&_h1]:text-lg [&_h2]:text-base [&_h3]:text-sm">
    <MemoizedMarkdown id="memory-document" content={content} components={memoryComponents} />
  </div>
)
