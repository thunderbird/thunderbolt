import type { SaveMessagesFunction, ThunderboltUIMessage } from '@/types'
import { oauthRetryEvent } from '@/widgets/connect-integration/constants'
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
 * Creates a synthetic message to notify the LLM that integration is connected.
 * This message is persisted to the database but hidden from the UI via metadata flag.
 */
const createContinuationMessage = (): ThunderboltUIMessage => ({
  id: uuidv7(),
  role: 'user',
  parts: [
    {
      type: 'text',
      text: '[The user has successfully connected their email/calendar integration. Please proceed with their previous request using the available tools.]',
    },
  ],
  metadata: {
    hideFromUser: true,
  },
})

/**
 * Hook that handles OAuth integration completion events.
 * When an integration is connected, it appends a synthetic message that notifies
 * the LLM that tools are now available. The message is hidden from users via metadata.
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

      oauthRetryHandledRef.current.add(widgetMessageId)
      hasTriggeredRef.current = false

      // Invalidate integration status so tools become available
      queryClient.invalidateQueries({ queryKey: ['integrationStatus'] })

      // Wait for integration status to update
      await new Promise((resolve) => setTimeout(resolve, 500))

      try {
        // Add synthetic message to state and save it with hideFromUser flag
        const continuationMessage = createContinuationMessage()
        const newMessages = [...chatMessages, continuationMessage]

        chatHelpers.setMessages(newMessages)

        // Save the synthetic message to DB (it will be hidden in UI via metadata)
        await saveMessages({
          id,
          messages: [continuationMessage],
        })

        // Trigger LLM response now that tools are available
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
