/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { AssistantMessage } from '@/components/chat/assistant-message'
import { UserMessage } from '@/components/chat/user-message'
import { useMemo } from 'react'
import { SharedMessageBoundary } from './shared-message-boundary'
import { type ShareSnapshot, toUIMessage } from './snapshot'
import { SharedChatSnapshotProvider } from './snapshot-context'

type SharedTranscriptProps = {
  shareId: string
  version: string
  snapshot: ShareSnapshot
}

/**
 * A shared chat, read-only: the same message components a live chat renders,
 * inside the snapshot context so nothing reads the local database or a chat
 * session, and with no composer. Each message sits in its own error boundary.
 */
export const SharedTranscript = ({ shareId, version, snapshot }: SharedTranscriptProps) => {
  // Converted once per snapshot so the memoized message components keep their props.
  const messages = useMemo(
    () => snapshot.messages.map((message) => ({ role: message.role, ui: toUIMessage(message) })),
    [snapshot],
  )
  return (
    <SharedChatSnapshotProvider shareId={shareId} version={version} snapshot={snapshot}>
      <div data-testid="shared-transcript">
        {messages.map(({ role, ui }) => (
          <SharedMessageBoundary key={ui.id}>
            {role === 'user' ? <UserMessage message={ui} /> : <AssistantMessage message={ui} isStreaming={false} />}
          </SharedMessageBoundary>
        ))}
      </div>
    </SharedChatSnapshotProvider>
  )
}
