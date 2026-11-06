/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { compilableQueryWatch } from '@powersync/common'
import { toCompilableQuery } from '@powersync/drizzle-driver'
import { usePowerSync } from '@powersync/react'
import { useEffect } from 'react'
import { useDatabase } from '@/contexts'
import { getAvailableModels } from '@/dal/models'
import { useLocalProviders } from '@/hooks/use-local-providers'
import { useChatStore } from './chat-store'

/** Keep the non-React chat sessions current with model and connection changes in any window. */
export const useLiveChatModels = () => {
  const db = useDatabase()
  const powerSync = usePowerSync()
  const localProviders = useLocalProviders()

  useEffect(() => {
    const controller = new AbortController()
    compilableQueryWatch(
      powerSync,
      toCompilableQuery(getAvailableModels(db)),
      {
        onResult: (models) => {
          if (!controller.signal.aborted) {
            useChatStore.getState().setModels(models)
          }
        },
        onError: () => {
          if (!controller.signal.aborted) {
            console.error('Failed to refresh available chat models.')
            useChatStore.getState().setModels([])
          }
        },
      },
      { signal: controller.signal },
    )
    return () => controller.abort()
  }, [db, powerSync, localProviders])
}
