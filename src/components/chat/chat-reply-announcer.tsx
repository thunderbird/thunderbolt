/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useLingui } from '@lingui/react/macro'
import { useCurrentChatSession } from '@/chats/chat-store'
import type { ReplyAnnouncement } from '@/chats/reply-announcement'
import { useReplyAnnouncement } from '@/chats/use-reply-announcement'

/**
 * Screen-reader live regions for the chat reply (THU-1280): "responding" when a
 * turn starts, then the reply itself, "ready", "stopped", or an assertive
 * "failed". Both regions stay mounted and empty between announcements, because
 * a region inserted together with its text is not reliably read.
 */
export const ChatReplyAnnouncer = () => {
  const { t } = useLingui()
  const { selectedAgent } = useCurrentChatSession()
  const { polite, assertive } = useReplyAnnouncement()
  const agentName = selectedAgent.name

  const describe = (announcement: ReplyAnnouncement | null): string => {
    switch (announcement?.kind) {
      case 'responding':
        return t`${agentName} is responding`
      case 'reply':
        return announcement.text
      case 'ready':
        return t`Response ready`
      case 'stopped':
        return t`Response stopped`
      case 'failed':
        return t`Response failed`
      default:
        return ''
    }
  }

  return (
    <>
      <div role="status" className="sr-only">
        {describe(polite)}
      </div>
      <div role="alert" className="sr-only">
        {describe(assertive)}
      </div>
    </>
  )
}
