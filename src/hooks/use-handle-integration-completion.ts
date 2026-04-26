import { useDatabase } from '@/contexts'
import { oauthRetryEvent, getOAuthWidgetKey } from '@/widgets/connect-integration/constants'
import type { SaveMessagesFunction, ThunderboltUIMessage } from '@/types'
import { useEffect, useRef, useEffectEvent } from 'react'
import { useChatStore } from '@/chats/chat-store'
import { useShallow } from 'zustand/react/shallow'
import { useIntegrationStatus, type IntegrationStatus } from '@/hooks/use-integration-status'
import { useQueryClient } from '@tanstack/react-query'
import { v7 as uuidv7 } from 'uuid'
import { updateMessageCache } from '@/dal/chat-messages'
import { sendAcpPrompt as sendAcpPrompt_default } from '@/chats/use-acp-chat'

type UseHandleIntegrationCompletionParams = {
  saveMessages: SaveMessagesFunction
  sendPrompt?: typeof sendAcpPrompt_default
}

/**
 * Finds the original user message text before the widget message.
 */
const findOriginalUserText = (chatMessages: ThunderboltUIMessage[], widgetMessageIndex: number): string | null => {
  const userMessage = chatMessages
    .slice(0, widgetMessageIndex)
    .reverse()
    .find((msg) => msg.role === 'user')

  if (!userMessage) {
    return null
  }

  const textPart = userMessage.parts?.find((part) => part.type === 'text')
  if (!textPart || textPart.type !== 'text') {
    return null
  }

  return textPart.text ?? null
}

/**
 * Creates a retry message with the original user text and a note about successful integration.
 */
const createRetryMessage = (originalUserText: string): ThunderboltUIMessage => ({
  id: uuidv7(),
  role: 'user',
  parts: [
    {
      type: 'text',
      text: `${originalUserText}\n\n[Note: Email integration has been successfully connected. Please proceed with the requested action using the appropriate tools.]`,
    },
  ],
  metadata: {
    oauthRetry: true,
  },
})

/**
 * Polls for integration status until the provider is confirmed connected.
 */
const waitForProviderConnection = async (
  provider: 'google' | 'microsoft' | null,
  queryClient: { fetchQuery: <T>(options: { queryKey: string[] }) => Promise<T> },
  initialStatus: IntegrationStatus | null,
  maxAttempts = 20,
): Promise<IntegrationStatus | null> => {
  let currentStatus: IntegrationStatus | null = initialStatus

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (!currentStatus) {
      currentStatus = await queryClient.fetchQuery<IntegrationStatus>({ queryKey: ['integrationStatus'] })
    }

    const isProviderConnected =
      provider === 'google'
        ? currentStatus?.googleConnected
        : provider === 'microsoft'
          ? currentStatus?.microsoftConnected
          : false

    if (isProviderConnected) {
      return currentStatus
    }

    await new Promise((resolve) => setTimeout(resolve, 100))
    currentStatus = await queryClient.fetchQuery<IntegrationStatus>({ queryKey: ['integrationStatus'] })
  }

  return null
}

/**
 * Waits for the session to be ready before sending a message.
 */
const waitForSessionReady = async (sessionId: string, timeoutMs = 5000): Promise<void> => {
  const startTime = Date.now()

  while (true) {
    const session = useChatStore.getState().sessions.get(sessionId)
    if (session?.status === 'ready') {
      return
    }
    if (Date.now() - startTime > timeoutMs) {
      throw new Error(`Session not ready after ${timeoutMs}ms`)
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}

/**
 * Waits for a message to appear in the session's messages array.
 */
const waitForMessageInSession = async (
  sessionId: string,
  messageId: string,
  maxAttempts = 10,
  delayMs = 200,
): Promise<number> => {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const session = useChatStore.getState().sessions.get(sessionId)
    if (session) {
      const index = session.messages.findIndex((msg) => msg.id === messageId)
      if (index >= 0) {
        return index
      }
    }
    await new Promise((resolve) => setTimeout(resolve, delayMs))
  }
  return -1
}

/**
 * Hook that handles OAuth integration completion events.
 * When an integration is connected, it automatically retries the user's original request
 * by sending a new message with the original text and triggering a response.
 */
export const useHandleIntegrationCompletion = ({
  saveMessages,
  sendPrompt = sendAcpPrompt_default,
}: UseHandleIntegrationCompletionParams): void => {
  const db = useDatabase()
  const oauthRetryHandledRef = useRef<Set<string>>(new Set())

  const { sessionId } = useChatStore(
    useShallow((state) => {
      const session = state.sessions.get(state.currentSessionId ?? '')

      return {
        sessionId: session?.id,
      }
    }),
  )

  const { data: integrationStatus } = useIntegrationStatus()
  const queryClient = useQueryClient()

  const processRetryForWidget = useEffectEvent(
    async (widgetMessageId: string, provider: 'google' | 'microsoft' | null) => {
      const currentSessionId = useChatStore.getState().currentSessionId
      const currentSession = currentSessionId ? useChatStore.getState().sessions.get(currentSessionId) : undefined

      if (!widgetMessageId || !currentSessionId || !currentSession) {
        return
      }

      if (oauthRetryHandledRef.current.has(widgetMessageId)) {
        return
      }

      // Wait for integration status to confirm the connection
      const confirmedStatus = await waitForProviderConnection(provider, queryClient, integrationStatus)

      if (!confirmedStatus) {
        console.warn('Provider not connected after waiting:', provider)
        return
      }

      // Find widget message in chat history (with retry for race conditions)
      const widgetMessageIndex = await waitForMessageInSession(currentSessionId, widgetMessageId)

      if (widgetMessageIndex < 0) {
        console.warn('Widget message not found:', widgetMessageId)
        return
      }

      const currentMessages = useChatStore.getState().sessions.get(currentSessionId)?.messages ?? []
      const originalUserText = findOriginalUserText(currentMessages, widgetMessageIndex)
      if (!originalUserText) {
        console.warn('Original user text not found for widget message:', widgetMessageId)
        return
      }

      oauthRetryHandledRef.current.add(widgetMessageId)

      const retryMessage = createRetryMessage(originalUserText)
      const retryText = retryMessage.parts[0]?.type === 'text' ? retryMessage.parts[0].text : ''

      try {
        await saveMessages({
          id: currentSessionId,
          messages: [retryMessage],
        })

        try {
          await updateMessageCache(db, widgetMessageId, 'connectIntegrationWidget', { isHidden: true })
          queryClient.invalidateQueries({
            queryKey: ['messageCache', widgetMessageId, 'connectIntegrationWidget'],
          })
        } catch (err) {
          console.warn('Failed to mark widget as hidden:', err)
        }

        await waitForSessionReady(currentSessionId)

        await sendPrompt({
          sessionId: currentSessionId,
          text: retryText,
          metadata: { oauthRetry: true },
          saveMessages,
        })
      } catch (err) {
        console.error('Failed to process OAuth retry:', err)
        oauthRetryHandledRef.current.delete(widgetMessageId)
      }
    },
  )

  // Listen for OAuth completion events and process retries.
  // Dependency array is [sessionId] only — processRetryForWidget is a stable
  // useEffectEvent that reads fresh state via useChatStore.getState() on each call.
  useEffect(() => {
    const handleOAuthComplete = (event: CustomEvent<{ widgetMessageId: string }>) => {
      const { widgetMessageId } = event.detail
      if (!widgetMessageId) {
        return
      }

      const storedProvider = sessionStorage.getItem(getOAuthWidgetKey(widgetMessageId, 'provider')) as
        | 'google'
        | 'microsoft'
        | null

      void processRetryForWidget(widgetMessageId, storedProvider)
    }

    window.addEventListener(oauthRetryEvent, handleOAuthComplete as unknown as (event: Event) => void)
    return () => window.removeEventListener(oauthRetryEvent, handleOAuthComplete as unknown as (event: Event) => void)
  }, [sessionId])
}
