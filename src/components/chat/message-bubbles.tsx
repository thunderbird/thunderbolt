/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { UIMessage } from 'ai'
import { MemoizedMarkdown } from './memoized-markdown'

type MessageBubblesProps = {
  message: UIMessage
}

export const MessageBubbles = ({ message }: MessageBubblesProps) =>
  message.parts
    .filter((part) => part.type === 'text')
    .map((part, j) => (
      <div key={j} className="px-4 rounded-2xl max-w-3/4 bg-muted dark:bg-secondary/60 ml-auto mt-6">
        <div className="space-y-2">
          <MemoizedMarkdown id={`${message.id}_${j}`} content={part.text || ''} />
        </div>
      </div>
    ))
