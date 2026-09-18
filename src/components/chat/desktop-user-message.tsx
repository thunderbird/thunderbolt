/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { extractTextFromParts } from '@/lib/message-utils'
import type { UIMessage } from 'ai'
import { useMemo, type ReactNode } from 'react'
import { CopyMessageButton } from './copy-message-button'
import { MessageBubbles, type ResendAttachmentHandler } from './message-bubbles'

type DesktopUserMessageProps = {
  message: UIMessage
  lastMessageAction?: ReactNode
  onResendAttachment?: ResendAttachmentHandler
}

export const DesktopUserMessage = ({ message, lastMessageAction, onResendAttachment }: DesktopUserMessageProps) => {
  const copyText = useMemo(() => extractTextFromParts(message.parts), [message.parts])

  return (
    <div data-message-id={message.id} className="group/user-message">
      <MessageBubbles message={message} onResendAttachment={onResendAttachment} />
      <div className="pointer-events-none mt-1 ml-auto flex w-fit items-center gap-1.5 opacity-0 transition-opacity group-hover/user-message:pointer-events-auto group-hover/user-message:opacity-100">
        <CopyMessageButton text={copyText} />
        {lastMessageAction}
      </div>
    </div>
  )
}
