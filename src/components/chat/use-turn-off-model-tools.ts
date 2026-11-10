/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useMutation } from '@tanstack/react-query'

import { useChatStore } from '@/chats/chat-store'
import { useDatabase } from '@/contexts'
import { getAvailableModels, updateModel } from '@/dal'

type UseTurnOffModelToolsOptions = {
  /** Re-runs the failed turn once the model no longer sends tools. */
  regenerate: () => void
}

/** Turns tools off for the chat's selected model after it rejected them, then retries the
 *  turn. Writes the same synced setting as the Settings → Models switch. */
export const useTurnOffModelTools = ({ regenerate }: UseTurnOffModelToolsOptions) => {
  const db = useDatabase()
  const mutation = useMutation({
    mutationFn: async (sessionId: string) => {
      const store = useChatStore.getState()
      const session = store.sessions.get(sessionId)
      if (!session) {
        throw new Error('No session found')
      }
      await updateModel(db, session.selectedModel.id, { toolUsage: 0 })
      // Refresh canonical model rows while preserving any newer user selection.
      store.setModels(await getAvailableModels(db))
    },
    onSuccess: () => regenerate(),
    onError: (error: unknown) => console.error('Failed to turn off tools for the model.', error),
  })

  return { turnOffTools: mutation.mutate, isTurningOffTools: mutation.isPending }
}
