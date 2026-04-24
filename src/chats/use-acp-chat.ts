import {
  createMessageAccumulator,
  parseMeta,
  type MessageAccumulator,
  type SessionUpdate,
} from '@/acp/message-accumulator'
import { trackEvent } from '@/lib/posthog'
import type { SaveMessagesFunction, ThunderboltUIMessage } from '@/types'
import type { SourceMetadata } from '@/types/source'
import { v7 as uuidv7 } from 'uuid'
import { useChatStore } from './chat-store'
import { ensureAcpConnection } from './create-acp-session'
import { useCallback, useRef } from 'react'

export { maxRetries } from './constants'

type SendPromptOptions = {
  sessionId: string
  text: string
  metadata?: Record<string, unknown>
  saveMessages: SaveMessagesFunction
}

/**
 * Send a prompt through ACP and handle streaming response.
 * This is the core function that replaces the Chat class's sendMessage.
 */
export const sendAcpPrompt = async ({ sessionId, text, metadata, saveMessages }: SendPromptOptions) => {
  const store = useChatStore.getState()
  const session = store.sessions.get(sessionId)

  if (!session) {
    throw new Error('No session found')
  }

  const userMessage: ThunderboltUIMessage = {
    id: uuidv7(),
    role: 'user',
    parts: [{ type: 'text', text }],
    metadata: {
      ...metadata,
      modelId: session.selectedModel.id,
    },
  }

  store.appendMessage(sessionId, userMessage)
  store.setSessionStatus(sessionId, 'submitted')

  await saveMessages({ id: sessionId, messages: [userMessage] })

  const acpClient = await ensureAcpConnection(sessionId)

  const accumulator = createMessageAccumulator()
  const initialAssistantMessage = accumulator.buildMessage()
  store.appendMessage(sessionId, initialAssistantMessage)
  store.setSessionStatus(sessionId, 'streaming')

  try {
    activeAccumulators.set(sessionId, accumulator)

    const result = await acpClient.prompt(text)

    if (result._meta) {
      const meta = parseMeta(result._meta)
      if (meta?.documents) {
        accumulator.setDocuments(meta.documents)
      }
      if (meta?.documentReferences) {
        accumulator.setDocumentReferences(meta.documentReferences)
      }

      const rawSources = (result._meta as Record<string, unknown>)?.sources
      if (Array.isArray(rawSources)) {
        accumulator.setSources(rawSources as SourceMetadata[])
      }
    }

    const finalMessage = accumulator.buildMessage()
    store.updateLastMessage(sessionId, finalMessage)

    if (result.stopReason === 'end_turn' && accumulator.hasContent) {
      store.setSessionStatus(sessionId, 'ready')
      store.updateSession(sessionId, { retryCount: 0, retriesExhausted: false })

      await saveMessages({ id: sessionId, messages: [finalMessage] })

      trackEvent('chat_receive_reply', {
        model: session.selectedModel,
        length: finalMessage.parts.reduce((acc, part) => acc + (part.type === 'text' ? part.text.length : 0), 0),
        reply_number: store.sessions.get(sessionId)?.messages.length ?? 0,
      })
    } else if (result.stopReason === 'cancelled') {
      store.setSessionStatus(sessionId, 'ready')
    } else {
      // Empty or error response
      store.setSessionStatus(sessionId, 'error', new Error('Empty response from agent'))
    }
  } catch (error) {
    console.error('ACP prompt error:', error)
    const err = error instanceof Error ? error : new Error(typeof error === 'string' ? error : JSON.stringify(error))
    store.setSessionStatus(sessionId, 'error', err)
  } finally {
    activeAccumulators.delete(sessionId)
  }
}

const activeAccumulators = new Map<string, MessageAccumulator>()

/**
 * Handle an ACP session update by accumulating it into the current assistant message.
 */
export const handleSessionUpdate = (sessionId: string, update: SessionUpdate) => {
  const accumulator = activeAccumulators.get(sessionId)
  if (!accumulator) {
    return
  }

  const updatedMessage = accumulator.handleUpdate(update)
  useChatStore.getState().updateLastMessage(sessionId, updatedMessage)
}

/**
 * Hook that provides chat actions for the current session.
 * Replaces useChat from @ai-sdk/react.
 */
const noOpSaveMessages: SaveMessagesFunction = async () => {}

export const useAcpChatActions = (saveMessages?: SaveMessagesFunction) => {
  const effectiveSaveMessages = saveMessages ?? noOpSaveMessages
  const retryCountRef = useRef(0)
  const retryTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const sendMessage = useCallback(
    async (message: { text: string; metadata?: Record<string, unknown> }) => {
      const { currentSessionId } = useChatStore.getState()
      if (!currentSessionId) {
        throw new Error('No active session')
      }

      // Clear any pending retry
      if (retryTimeoutRef.current) {
        clearTimeout(retryTimeoutRef.current)
        retryTimeoutRef.current = null
      }
      retryCountRef.current = 0
      useChatStore.getState().updateSession(currentSessionId, { retryCount: 0, retriesExhausted: false })

      const session = useChatStore.getState().sessions.get(currentSessionId)
      if (!session) {
        throw new Error('No session found')
      }

      // Track send event
      trackEvent('chat_send_prompt', {
        model: session.selectedModel,
        length: message.text?.length ?? 0,
        prompt_number: session.messages.length + 1,
      })

      await sendAcpPrompt({
        sessionId: currentSessionId,
        text: message.text,
        metadata: message.metadata,
        saveMessages: effectiveSaveMessages,
      })
    },
    [effectiveSaveMessages],
  )

  const regenerate = useCallback(async () => {
    const { currentSessionId, sessions } = useChatStore.getState()
    if (!currentSessionId) {
      return
    }

    const session = sessions.get(currentSessionId)
    if (!session) {
      return
    }

    // Clear retry state
    if (retryTimeoutRef.current) {
      clearTimeout(retryTimeoutRef.current)
      retryTimeoutRef.current = null
    }
    retryCountRef.current = 0
    useChatStore.getState().updateSession(currentSessionId, { retryCount: 0, retriesExhausted: false })

    // Find the last user message
    const messages = session.messages
    const lastUserMessageIndex = messages.findLastIndex((m) => m.role === 'user')

    if (lastUserMessageIndex < 0) {
      return
    }

    const lastUserMessage = messages[lastUserMessageIndex]
    const userText = lastUserMessage.parts
      .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
      .map((p) => p.text)
      .join('\n')

    // Remove messages after last user message (the failed response)
    const truncatedMessages = messages.slice(0, lastUserMessageIndex + 1)
    useChatStore.getState().updateSession(currentSessionId, { messages: truncatedMessages })

    // Re-send
    await sendAcpPrompt({
      sessionId: currentSessionId,
      text: userText,
      metadata: lastUserMessage.metadata,
      saveMessages: effectiveSaveMessages,
    })
  }, [effectiveSaveMessages])

  const stop = useCallback(async () => {
    const { currentSessionId, sessions } = useChatStore.getState()
    if (!currentSessionId) {
      return
    }

    const session = sessions.get(currentSessionId)
    if (!session?.acpClient) {
      return
    }

    await session.acpClient.cancel()
    useChatStore.getState().setSessionStatus(currentSessionId, 'ready')
  }, [])

  return { sendMessage, regenerate, stop }
}
