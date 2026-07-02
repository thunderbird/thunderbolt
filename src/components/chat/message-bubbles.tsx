/* This Source Code Form is subject to the terms of the Mozilla Public
   - License, v. 2.0. If a copy of the MPL was not distributed with this
   - file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { getAttachments } from '@/chats/message-utils'
import { useShowSideview } from '@/sideview/sideview-store'
import type { ThunderboltUIMessage } from '@/chats/types'
import { buildDocumentSideviewId } from '@/sideview/sideview-id-builder'
import type { UIMessage } from 'ai'
import { MemoizedMarkdown } from './memoized-markdown'
import { FileCard } from './file-card'
import type { ResendAttachmentHandler } from './file-card'

type MessageBubblesProps = {
  message: UIMessage
  onResendAttachment?: ResendAttachmentHandler
}

<<<<<<< HEAD
export const MessageBubbles = ({ message, onResendAttachment }: MessageBubblesProps) => {
  const showSideview = useShowSideview()
  const attachments = getAttachments(message as ThunderboltUIMessage)

  return (
    <>
      {attachments.length > 0 && (
        <div className="ml-auto mt-6 flex max-w-3/4 flex-wrap justify-end gap-2">
          {attachments.map((attachment) => {
            const resendTargets =
              onResendAttachment && attachment.deliverAs
                ? (['text', 'images'] as const).filter(
                    (target) => attachment.deliverAs !== target && hasTransformer(attachment.mimeType, target),
                  )
                : []
            return (
              <FileCard
                key={attachment.localFileId}
                localFileId={attachment.localFileId}
                filename={attachment.filename}
                mimeType={attachment.mimeType}
                deliverAs={attachment.deliverAs}
                resendTargets={resendTargets}
                onResend={
                  onResendAttachment ? (target) => onResendAttachment(attachment.localFileId, target) : undefined
                }
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
            )
          })}
=======
export const MessageBubbles = ({ message }: MessageBubblesProps) =>
  message.parts
    .filter((part) => part.type === 'text')
    .map((part, j) => (
      <div key={j} className="px-4 rounded-2xl max-w-3/4 bg-[#e8e8e8] dark:bg-secondary/60 ml-auto mt-6 text-[14px]">
        <div className="space-y-2">
          <MemoizedMarkdown id={`${message.id}_${j}`} content={part.text || ''} />
>>>>>>> 53c39843 (style: eliminate pure white/black and swap heading font to EB Garamond)
        </div>
      )}
      {message.parts
        .filter((part) => part.type === 'text')
        .map((part, j) => (
          <div key={j} className="px-4 rounded-2xl max-w-3/4 bg-accent dark:bg-secondary/60 ml-auto mt-6 text-[14px]">
            <div className="space-y-2">
              <MemoizedMarkdown id={`${message.id}_${j}`} content={part.text || ''} />
            </div>
          </div>
        ))}
    </>
  )
}
