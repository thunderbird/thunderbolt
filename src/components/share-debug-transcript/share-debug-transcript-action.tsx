/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { ChatSession } from '@/chats/chat-store'
import { useAuth } from '@/contexts/auth-context'
import { ShareDebugTranscriptButton } from './share-debug-transcript-button'
import { ShareDebugTranscriptDialog } from './share-debug-transcript-dialog'
import { ShareDebugTranscriptToast } from './share-debug-transcript-toast'
import { useShareDebugTranscriptState } from './use-share-debug-transcript-state'

type ShareDebugTranscriptActionProps = {
  chatInstance: ChatSession['chatInstance']
  threadId: string
}

const ShareDebugTranscriptActionContent = ({ chatInstance, threadId }: ShareDebugTranscriptActionProps) => {
  const state = useShareDebugTranscriptState({ chatInstance, threadId })

  return (
    <>
      <ShareDebugTranscriptButton {...state.action} />
      <ShareDebugTranscriptDialog {...state.dialog} />
      <ShareDebugTranscriptToast {...state.toast} />
    </>
  )
}

/** Hide identified transcript sharing from anonymous sessions. */
export const ShareDebugTranscriptAction = (props: ShareDebugTranscriptActionProps) => {
  const authClient = useAuth()
  const { data: authSession } = authClient.useSession()

  if (authSession?.user?.isAnonymous === true) {
    return null
  }

  return <ShareDebugTranscriptActionContent {...props} />
}
