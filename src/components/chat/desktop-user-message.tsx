/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { extractTextFromParts } from '@/lib/message-utils'
import type { UIMessage } from 'ai'
import { useMemo } from 'react'
import { CopyMessageButton } from './copy-message-button'
import { MessageBubbles, type ResendAttachmentHandler } from './message-bubbles'

type DesktopUserMessageProps = {
  message: UIMessage
  onResendAttachment?: ResendAttachmentHandler
}

export const DesktopUserMessage = ({ message, onResendAttachment }: DesktopUserMessageProps) => {
  const copyText = useMemo(() => extractTextFromParts(message.parts), [message.parts])

  return (
    <div data-message-id={message.id} className="group">
      <MessageBubbles message={message} onResendAttachment={onResendAttachment} />
      <div className="flex justify-end opacity-0 group-hover:opacity-100 transition-opacity mt-1">
        <CopyMessageButton text={copyText} />
      </div>
    </div>
  )
}
