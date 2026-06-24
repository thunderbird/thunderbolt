/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useShowSideview } from '@/content-view/context'
import { getAttachments } from '@/lib/attachments'
import type { ThunderboltUIMessage } from '@/types'
import { buildDocumentSideviewId } from '@/types/citation'
import type { UIMessage } from 'ai'
import { FileChip } from './file-chip'
import { MemoizedMarkdown } from './memoized-markdown'

type MessageBubblesProps = {
  message: UIMessage
}

export const MessageBubbles = ({ message }: MessageBubblesProps) => {
  const showSideview = useShowSideview()
  const attachments = getAttachments(message as ThunderboltUIMessage)

  return (
    <>
      {attachments.length > 0 && (
        <div className="ml-auto mt-6 flex max-w-3/4 flex-wrap justify-end gap-2">
          {attachments.map((attachment) => (
            <FileChip
              key={attachment.localFileId}
              filename={attachment.filename}
              onOpen={
                showSideview
                  ? () =>
                      showSideview(
                        'local-file',
                        buildDocumentSideviewId({ fileId: attachment.localFileId, fileName: attachment.filename }),
                      )
                  : undefined
              }
            />
          ))}
        </div>
      )}
      {message.parts
        .filter((part) => part.type === 'text')
        .map((part, j) => (
          <div key={j} className="px-4 rounded-2xl max-w-3/4 bg-muted dark:bg-secondary/60 ml-auto mt-6">
            <div className="space-y-2">
              <MemoizedMarkdown id={`${message.id}_${j}`} content={part.text || ''} />
            </div>
          </div>
        ))}
    </>
  )
}
