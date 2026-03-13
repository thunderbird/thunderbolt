import { useChatStore } from '@/chats/chat-store'
import type { HaystackDocumentMeta } from '@/types'
import { useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'

/**
 * Returns the Haystack document chunks for a given file from a specific message's metadata.
 * Chunks are sorted by score descending.
 */
export const useDocumentChunks = (messageId: string, fileId: string): HaystackDocumentMeta[] => {
  const messages = useChatStore(
    useShallow((state) => {
      const sessionId = state.currentSessionId
      if (!sessionId) return []
      const session = state.sessions.get(sessionId)
      if (!session) return []
      return session.chatInstance.messages
    }),
  )

  return useMemo(() => {
    const message = messages.find((m) => m.id === messageId)
    if (!message) return []

    const docs = (message.metadata?.haystackDocuments ?? []) as HaystackDocumentMeta[]
    return docs.filter((d) => d.file.id === fileId).sort((a, b) => b.score - a.score)
  }, [messages, messageId, fileId])
}
