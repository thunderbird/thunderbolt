/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useState, useTransition } from 'react'
import { useLingui } from '@lingui/react/macro'
import type { ChatDrop } from './chat-drop'
import {
  ActiveChatProjectMoveError,
  ProjectMoveConfirmationRequired,
  useMoveChatToProject,
} from './use-move-chat-to-project'

type PendingMove = { drop: ChatDrop; environmentChange: string }

/** Share environment confirmation and failures across menu, picker, and drag moves. */
export const useProjectMoveFeedback = () => {
  const { t } = useLingui()
  const moveChat = useMoveChatToProject()
  const [error, setError] = useState<string | null>(null)
  const [confirmation, setConfirmation] = useState<PendingMove | null>(null)
  const [isConfirming, startTransition] = useTransition()
  const attemptMove = async (drop: ChatDrop, confirmedEnvironmentChange?: string) => {
    setError(null)
    try {
      await moveChat(drop, confirmedEnvironmentChange)
      setConfirmation(null)
    } catch (cause) {
      if (cause instanceof ProjectMoveConfirmationRequired) {
        setConfirmation({ drop, environmentChange: cause.environmentChange })
        return
      }
      setConfirmation(null)
      setError(
        cause instanceof ActiveChatProjectMoveError
          ? t`Stop the current reply before moving this chat to another project.`
          : t`Could not move this chat. Please try again.`,
      )
      if (!(cause instanceof ActiveChatProjectMoveError)) {
        console.error('Moving a chat into a project failed', { ...drop, error: cause })
      }
    }
  }
  return {
    error,
    clearError: () => setError(null),
    moveChat: (drop: ChatDrop) => attemptMove(drop),
    confirmation,
    isConfirming,
    cancelMove: () => setConfirmation(null),
    confirmMove: () => {
      if (!confirmation || isConfirming) {
        return
      }
      startTransition(async () => {
        await attemptMove(confirmation.drop, confirmation.environmentChange)
      })
    },
  }
}
