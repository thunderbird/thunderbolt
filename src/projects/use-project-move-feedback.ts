/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useState } from 'react'
import { useLingui } from '@lingui/react/macro'
import type { ChatDrop } from './chat-drop'
import { ActiveChatProjectMoveError, useMoveChatToProject } from './use-move-chat-to-project'

/** Surface rejected menu and drag moves without throwing through a transition. */
export const useProjectMoveFeedback = () => {
  const { t } = useLingui()
  const moveChat = useMoveChatToProject()
  const [error, setError] = useState<string | null>(null)
  return {
    error,
    clearError: () => setError(null),
    moveChat: async (drop: ChatDrop) => {
      setError(null)
      try {
        await moveChat(drop)
      } catch (cause) {
        setError(
          cause instanceof ActiveChatProjectMoveError
            ? t`Stop the current reply before moving this chat to another project.`
            : t`Could not move this chat. Please try again.`,
        )
        if (!(cause instanceof ActiveChatProjectMoveError)) {
          console.error('Moving a chat into a project failed', { ...drop, error: cause })
        }
      }
    },
  }
}
