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
      const model = { ...session.selectedModel, toolUsage: 0 }
      await updateModel(db, model.id, { toolUsage: 0 })
      // setModels keeps each session's current model object, so swap the updated one in,
      // unless the user picked another model while this saved.
      if (useChatStore.getState().sessions.get(sessionId)?.selectedModel.id === model.id) {
        store.updateSession(sessionId, { selectedModel: model })
      }
      store.setModels(await getAvailableModels(db))
    },
    onSuccess: () => regenerate(),
    onError: (error: unknown) => console.error('Failed to turn off tools for the model.', error),
  })

  return { turnOffTools: mutation.mutate, isTurningOffTools: mutation.isPending }
}
