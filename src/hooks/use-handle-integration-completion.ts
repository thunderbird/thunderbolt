/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useDatabase } from '@/contexts'
import { oauthRetryEvent, getOAuthWidgetKey } from '@/widgets/connect-integration/constants'
import type { SaveMessagesFunction, ThunderboltUIMessage } from '@/types'
import { useEffect, useEffectEvent, useRef } from 'react'
import { useChatStore } from '@/chats/chat-store'
import { useShallow } from 'zustand/react/shallow'
import { useIntegrationStatus, type IntegrationStatus } from '@/hooks/use-integration-status'
import { useQueryClient } from '@tanstack/react-query'
import { v7 as uuidv7 } from 'uuid'
import { updateMessageCache } from '@/dal/chat-messages'

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
 * Returns the status once confirmed, or null if timeout is reached.
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
 * Waits for the chat instance to be ready before sending a message.
 * Throws an error if the timeout is reached.
 */
const waitForChatReady = async (chatInstance: { status: string }, timeoutMs = 5000): Promise<void> => {
  const startTime = Date.now()

  while (chatInstance.status !== 'ready') {
    if (Date.now() - startTime > timeoutMs) {
      throw new Error(`Chat instance not ready after ${timeoutMs}ms`)
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}

/**
 * Waits for a message to appear in the chat instance's messages array.
 * Returns the message index if found, or -1 if timeout is reached.
 */
const waitForMessageInChat = async (
  chatInstance: { messages: ThunderboltUIMessage[] },
  messageId: string,
  maxAttempts = 10,
  delayMs = 200,
): Promise<number> => {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const index = chatInstance.messages.findIndex((msg) => msg.id === messageId)
    if (index >= 0) {
      return index
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
export const useHandleIntegrationCompletion = ({ saveMessages }: UseHandleIntegrationCompletionParams): void => {
  const db = useDatabase()
  const oauthRetryHandledRef = useRef<Set<string>>(new Set())

  const { chatInstance, chatThreadId } = useChatStore(
    useShallow((state) => {
      const session = state.sessions.get(state.currentSessionId ?? '')

      return {
        chatInstance: session?.chatInstance,
        chatThreadId: session?.id,
      }
    }),
  )

  const { data: integrationStatus } = useIntegrationStatus()
  const queryClient = useQueryClient()

  const onOAuthComplete = useEffectEvent(async (event: CustomEvent<{ widgetMessageId: string }>) => {
    const { widgetMessageId } = event.detail
    if (!widgetMessageId || !chatInstance || !chatThreadId) {
      return
    }

    if (oauthRetryHandledRef.current.has(widgetMessageId)) {
      return
    }

    const storedProvider = sessionStorage.getItem(getOAuthWidgetKey(widgetMessageId, 'provider')) as
      | 'google'
      | 'microsoft'
      | null

    // Wait for integration status to confirm the connection
    const confirmedStatus = await waitForProviderConnection(storedProvider, queryClient, integrationStatus)

    if (!confirmedStatus) {
      console.warn('Provider not connected after waiting:', storedProvider)
      return
    }

    // Find widget message in chat history (with retry for race conditions)
    const widgetMessageIndex = await waitForMessageInChat(chatInstance, widgetMessageId)

    if (widgetMessageIndex < 0) {
      console.warn('Widget message not found:', widgetMessageId)
      return
    }

    const originalUserText = findOriginalUserText(chatInstance.messages, widgetMessageIndex)
    if (!originalUserText) {
      console.warn('Original user text not found for widget message:', widgetMessageId)
      return
    }

    oauthRetryHandledRef.current.add(widgetMessageId)

    const retryMessage = createRetryMessage(originalUserText)
    const retryText = retryMessage.parts[0]?.type === 'text' ? retryMessage.parts[0].text : ''

    try {
      await saveMessages({
        id: chatThreadId,
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

      await waitForChatReady(chatInstance)

      await chatInstance.sendMessage({
        text: retryText,
        metadata: {
          oauthRetry: true,
        },
      })
    } catch (err) {
      console.error('Failed to process OAuth retry:', err)
      oauthRetryHandledRef.current.delete(widgetMessageId)
    }
  })

  // Listen for OAuth completion events and process retries
  useEffect(() => {
    const handler = (event: Event) => onOAuthComplete(event as CustomEvent<{ widgetMessageId: string }>)
    window.addEventListener(oauthRetryEvent, handler)
    return () => window.removeEventListener(oauthRetryEvent, handler)
  }, [onOAuthComplete])
}
