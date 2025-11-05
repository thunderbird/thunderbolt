import { oauthRetryEvent } from '@/widgets/connect-integration/constants'
import type { SaveMessagesFunction, ThunderboltUIMessage } from '@/types'
import type { UseChatHelpers } from '@ai-sdk/react'
import { useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, type RefObject } from 'react'
import { v7 as uuidv7 } from 'uuid'

type UseHandleIntegrationCompletionParams = {
  chatHelpers: UseChatHelpers<ThunderboltUIMessage>
  saveMessages: SaveMessagesFunction
  id: string
  status: string
  chatMessages: ThunderboltUIMessage[]
  hasTriggeredRef: RefObject<boolean>
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
 * Hook that handles OAuth integration completion events.
 * When an integration is connected, it automatically retries the user's original request
 * by creating a new message with the original text and triggering regeneration.
 */
export const useHandleIntegrationCompletion = ({
  chatHelpers,
  saveMessages,
  id,
  status,
  chatMessages,
  hasTriggeredRef,
}: UseHandleIntegrationCompletionParams): void => {
  const queryClient = useQueryClient()
  const oauthRetryHandledRef = useRef<Set<string>>(new Set())

  useEffect(() => {
    const handleOAuthRetry = async (event: CustomEvent<{ widgetMessageId: string }>) => {
      const { widgetMessageId } = event.detail

      if (!widgetMessageId || status !== 'ready') return
      if (oauthRetryHandledRef.current.has(widgetMessageId)) return

      const widgetMessageIndex = chatMessages.findIndex((msg) => msg.id === widgetMessageId)
      if (widgetMessageIndex < 0) return

      const originalUserText = findOriginalUserText(chatMessages, widgetMessageIndex)
      if (!originalUserText) return

      oauthRetryHandledRef.current.add(widgetMessageId)
      hasTriggeredRef.current = false

      queryClient.invalidateQueries({ queryKey: ['integrationStatus'] })
      await new Promise((resolve) => setTimeout(resolve, 500))

      const retryMessage = createRetryMessage(originalUserText)
      const messagesBeforeWidget = chatMessages.slice(0, widgetMessageIndex)
      const newMessages = [...messagesBeforeWidget, retryMessage]

      chatHelpers.setMessages(newMessages)

      try {
        await saveMessages({
          id,
          messages: [retryMessage],
        })

        await chatHelpers.regenerate()
      } catch (err) {
        console.error('Failed to process OAuth retry:', err)
        oauthRetryHandledRef.current.delete(widgetMessageId)
      }
    }

    window.addEventListener(oauthRetryEvent, handleOAuthRetry as unknown as (event: Event) => void)
    return () => window.removeEventListener(oauthRetryEvent, handleOAuthRetry as unknown as (event: Event) => void)
  }, [status, chatMessages, chatHelpers, id, saveMessages, queryClient, hasTriggeredRef])
}
