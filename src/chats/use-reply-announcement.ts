/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useChat } from '@ai-sdk/react'
import { useEffect, useState } from 'react'
import type { ThunderboltUIMessage } from '@/types'
import { isVoiceModeActive } from '@/voice/voice-mode'
import { toSpeakable } from '@/voice/speakable'
import { useCurrentChatSession } from './chat-store'
import { statusOnlyThrottleMs } from './chat-throttle'
import {
  clearFinishedAnnouncement,
  finishedAnnouncementMs,
  getReplyPhase,
  isFinishedAnnouncement,
  nextReplyAnnouncement,
  type ReplyAnnouncementState,
} from './reply-announcement'
import { getTurnActivity } from './turn-activity'

const replyText = (messages: ThunderboltUIMessage[]): string => {
  const reply = messages.findLast((message) => message.role === 'assistant' && message.metadata?.oauthRetry !== true)
  const text = reply?.parts.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join(' ') ?? ''
  return toSpeakable(text)
}

/**
 * What the chat's screen-reader live regions should say about the current reply.
 * Subscribes at the status-only cadence: it re-renders when `status` changes, and
 * `useChat` reads the latest messages on that render, so the finished reply is
 * complete without following every streamed token.
 */
export const useReplyAnnouncement = (): ReplyAnnouncementState => {
  const { chatInstance, retryCount, retriesExhausted, stopping } = useCurrentChatSession()
  const { messages, status, error } = useChat({ chat: chatInstance, experimental_throttle: statusOnlyThrottleMs })
  const activity = getTurnActivity({
    status,
    lastMessage: messages.at(-1),
    hasChatError: error != null,
    retriesExhausted,
    retryCount,
    stopRequested: stopping,
  })
  const phase = getReplyPhase(activity, { retriesExhausted, stopped: stopping })

  const [state, setState] = useState<ReplyAnnouncementState>({ phase, polite: null, assertive: null })

  // Empty the polite region once a finished turn has been read, so the reply isn't
  // left in the page for a second encounter outside the thread.
  const { polite } = state
  useEffect(() => {
    if (!isFinishedAnnouncement(polite)) {
      return
    }
    const timer = setTimeout(
      () => setState((current) => clearFinishedAnnouncement(current, polite)),
      finishedAnnouncementMs,
    )
    return () => clearTimeout(timer)
  }, [polite])

  // Adjusting state during render on a phase change, so the region updates in the same commit.
  if (phase !== state.phase) {
    const next = nextReplyAnnouncement(state, {
      phase,
      stopped: stopping,
      replyText: phase === 'idle' ? replyText(messages) : '',
      muted: isVoiceModeActive(),
    })
    setState(next)
    return next
  }
  return state
}
