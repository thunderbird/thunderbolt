/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { hasTransformer } from '@/files/transformers'
import { useShowSideview } from '@/content-view/context'
import { getAttachments } from '@/lib/attachments'
import { getQuotes } from '@/lib/quotes'
import type { ThunderboltUIMessage } from '@/types'
import { buildDocumentSideviewId } from '@/types/citation'
import type { UIMessage } from 'ai'
import { FileCard } from './file-card'
import { MemoizedMarkdown } from './memoized-markdown'

/** Re-deliver a single attachment as text/images and re-run the turn. */
export type ResendAttachmentHandler = (localFileId: string, target: 'text' | 'images') => void

type MessageBubblesProps = {
  message: UIMessage
  onResendAttachment?: ResendAttachmentHandler
}

export const MessageBubbles = ({ message, onResendAttachment }: MessageBubblesProps) => {
  const showSideview = useShowSideview()
  const attachments = getAttachments(message as ThunderboltUIMessage)
  const quotes = getQuotes(message as ThunderboltUIMessage)

  return (
    <>
      {quotes.length > 0 && (
        <div className="ml-auto mt-6 flex max-w-3/4 flex-col gap-1.5">
          {quotes.map((quote, i) => (
            <blockquote
              key={i}
              className="whitespace-pre-wrap rounded-md border border-l-2 border-l-primary/60 bg-muted/50 py-1.5 pl-3 pr-3 text-[length:var(--font-size-sm)] text-muted-foreground dark:bg-secondary/40"
            >
              {quote.text}
            </blockquote>
          ))}
        </div>
      )}
      {attachments.length > 0 && (
        <div className="ml-auto mt-6 flex max-w-3/4 flex-wrap justify-end gap-2">
          {attachments.map((attachment) => {
            // Alternative delivery modes to offer, but only on the latest turn and
            // only once a non-native mode is in effect (i.e. remediation already
            // converted this file) — so a clean native send shows no resend noise.
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
        </div>
      )}
      {message.parts
        .filter((part) => part.type === 'text')
        .map((part, j) => (
          <div key={j} className="px-4 rounded-2xl max-w-3/4 bg-accent dark:bg-secondary/60 ml-auto mt-6">
            <div className="space-y-2">
              <MemoizedMarkdown id={`${message.id}_${j}`} content={part.text || ''} />
            </div>
          </div>
        ))}
    </>
  )
}
