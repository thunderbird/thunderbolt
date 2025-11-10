import { useMessageCache } from '@/hooks/use-message-cache'

/**
 * Hook to check if the connect-integration widget should be hidden
 * Uses message cache to persist hidden state across refreshes
 */
export const useWidgetHiddenState = (messageId: string): boolean => {
  const { data: isHidden } = useMessageCache<boolean>({
    messageId,
    cacheKey: ['connectIntegrationWidget', 'isHidden'],
    fetchFn: async () => false,
  })

  return isHidden ?? false
}
