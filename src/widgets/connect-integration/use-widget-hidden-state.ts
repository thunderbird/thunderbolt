/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useMessageCache } from '@/hooks/use-message-cache'
import type { CacheData } from './schema'

/**
 * Hook to check if the connect-integration widget should be hidden
 * Uses message cache to persist hidden state across refreshes
 * @param messageId - Message ID to check
 * @param widgetName - Widget name to check (only queries if 'connect-integration')
 */
export const useWidgetHiddenState = (messageId: string, widgetName: string): boolean => {
  const { data: cacheData } = useMessageCache<CacheData>({
    messageId,
    cacheKey: ['connectIntegrationWidget'],
    fetchFn: async () => ({ isHidden: false }),
    enabled: widgetName === 'connect-integration',
  })

  return cacheData?.isHidden ?? false
}
