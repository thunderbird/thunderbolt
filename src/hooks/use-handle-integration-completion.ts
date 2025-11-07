import { oauthRetryEvent, getOAuthWidgetKey } from '@/widgets/connect-integration/constants'
import type { SaveMessagesFunction, ThunderboltUIMessage } from '@/types'
import { useEffect, useRef } from 'react'
import { useChatStore } from '@/chats/chat-store'
import { useShallow } from 'zustand/react/shallow'
import { useIntegrationStatus, type IntegrationStatus } from '@/hooks/use-integration-status'
import { useQueryClient } from '@tanstack/react-query'
import { v7 as uuidv7 } from 'uuid'

type UseHandleIntegrationCompletionParams = {
  saveMessages: SaveMessagesFunction
}

/**
 * Finds the original user message text before the widget message.
 */
const findOriginalUserText = (chatMessages: ThunderboltUIMessage[], widgetMessageIndex: number): string | null => {
  const userMessage = chatMessages
    .slice(0, widgetMessageIndex)
    .reverse()
    .find((msg) => msg.role === 'user')

  if (!userMessage) return null

  const textPart = userMessage.parts?.find((part) => part.type === 'text')
  if (!textPart || textPart.type !== 'text') return null

  return textPart.text || null
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
 * Returns the status once confirmed, or null if timeout is reached.
 */
const waitForProviderConnection = async (
  provider: 'google' | 'microsoft' | null,
  queryClient: { fetchQuery: <T>(options: { queryKey: string[] }) => Promise<T> },
  initialStatus: IntegrationStatus | null,
  maxAttempts = 20,
): Promise<IntegrationStatus | null> => {
  let currentStatus: IntegrationStatus | null = initialStatus
  let attempts = 0

  while (attempts < maxAttempts) {
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
    attempts++
  }

  return null
}

/**
 * Hook that handles OAuth integration completion events.
 * When an integration is connected, it automatically retries the user's original request
 * by sending a new message with the original text and triggering a response.
 */
export const useHandleIntegrationCompletion = ({ saveMessages }: UseHandleIntegrationCompletionParams): void => {
  const oauthRetryHandledRef = useRef<Set<string>>(new Set())
  const pendingRetriesRef = useRef<Map<string, { provider: 'google' | 'microsoft' | null }>>(new Map())

  const { chatInstance, chatThreadId } = useChatStore(
    useShallow((state) => ({
      chatInstance: state.chatInstance,
      chatThreadId: state.id,
    })),
  )

  const { data: integrationStatus } = useIntegrationStatus()
  const queryClient = useQueryClient()

  // Listen for OAuth completion events and store pending retries
  useEffect(() => {
    const handleOAuthComplete = (event: CustomEvent<{ widgetMessageId: string }>) => {
      const { widgetMessageId } = event.detail
      if (!widgetMessageId) return

      const storedProvider = sessionStorage.getItem(getOAuthWidgetKey(widgetMessageId, 'provider')) as
        | 'google'
        | 'microsoft'
        | null

      pendingRetriesRef.current.set(widgetMessageId, { provider: storedProvider })

      // Trigger processing immediately (don't wait for integrationStatus to change)
      // The processRetry function will poll until status is confirmed
      if (chatInstance && chatThreadId) {
        processRetryForWidget(widgetMessageId, storedProvider)
      }
    }

    const processRetryForWidget = async (widgetMessageId: string, provider: 'google' | 'microsoft' | null) => {
      if (oauthRetryHandledRef.current.has(widgetMessageId)) return

      // Wait for integration status to confirm the connection
      const confirmedStatus = await waitForProviderConnection(provider, queryClient, integrationStatus)

      if (!confirmedStatus) {
        console.warn('Provider not connected after waiting:', provider)
        pendingRetriesRef.current.delete(widgetMessageId)
        return
      }

      const findWidgetMessage = (currentMessages: ThunderboltUIMessage[]) => {
        return currentMessages.findIndex((msg) => msg.id === widgetMessageId)
      }

      let currentMessages = chatInstance!.messages
      let widgetMessageIndex = findWidgetMessage(currentMessages)
      if (widgetMessageIndex < 0) {
        for (let i = 0; i < 10; i++) {
          await new Promise((resolve) => setTimeout(resolve, 200))
          currentMessages = chatInstance!.messages
          widgetMessageIndex = findWidgetMessage(currentMessages)
          if (widgetMessageIndex >= 0) break
        }
      }

      if (widgetMessageIndex < 0) {
        console.warn('Widget message not found:', widgetMessageId)
        pendingRetriesRef.current.delete(widgetMessageId)
        return
      }

      const originalUserText = findOriginalUserText(currentMessages, widgetMessageIndex)
      if (!originalUserText) {
        console.warn('Original user text not found for widget message:', widgetMessageId)
        pendingRetriesRef.current.delete(widgetMessageId)
        return
      }

      oauthRetryHandledRef.current.add(widgetMessageId)
      pendingRetriesRef.current.delete(widgetMessageId)

      const retryMessage = createRetryMessage(originalUserText)
      const textPart = retryMessage.parts[0]
      const retryText = textPart.type === 'text' ? textPart.text : ''

      try {
        await saveMessages({
          id: chatThreadId!,
          messages: [retryMessage],
        })

        while (chatInstance!.status !== 'ready') {
          await new Promise((resolve) => setTimeout(resolve, 100))
        }

        await chatInstance!.sendMessage({
          text: retryText,
          metadata: {
            oauthRetry: true,
          },
        })
      } catch (err) {
        console.error('Failed to process OAuth retry:', err)
        oauthRetryHandledRef.current.delete(widgetMessageId)
      }
    }

    window.addEventListener(oauthRetryEvent, handleOAuthComplete as unknown as (event: Event) => void)
    return () => window.removeEventListener(oauthRetryEvent, handleOAuthComplete as unknown as (event: Event) => void)
  }, [chatInstance, chatThreadId, integrationStatus, queryClient, saveMessages])
}
