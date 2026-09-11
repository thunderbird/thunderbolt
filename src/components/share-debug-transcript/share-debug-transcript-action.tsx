/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { ChatSession } from '@/chats/chat-store'
import { ShareDebugTranscriptButton } from './share-debug-transcript-button'
import { ShareDebugTranscriptDialog } from './share-debug-transcript-dialog'
import { ShareDebugTranscriptToast } from './share-debug-transcript-toast'
import { useShareDebugTranscriptState } from './use-share-debug-transcript-state'

type ShareDebugTranscriptActionProps = {
  chatInstance: ChatSession['chatInstance']
  threadId: string
}

export const ShareDebugTranscriptAction = ({ chatInstance, threadId }: ShareDebugTranscriptActionProps) => {
  const state = useShareDebugTranscriptState({ chatInstance, threadId })

  return (
    <>
      <ShareDebugTranscriptButton {...state.action} />
      <ShareDebugTranscriptDialog {...state.dialog} />
      <ShareDebugTranscriptToast {...state.toast} />
    </>
  )
}
