/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useEffect, useRef, type Dispatch } from 'react'

import type { McpOAuthCallback } from '@/hooks/use-mcp-server-oauth'
import { getConnectionsOAuthCallback } from './oauth-callback'
import type { ConnectionsPageAction } from './page-state'

type ConnectionsOAuthCallbackControllerOptions = {
  locationState: unknown
  processMcpCallback: (callback: McpOAuthCallback) => unknown | Promise<unknown>
  processIntegrationCallback: (callback: McpOAuthCallback) => unknown | Promise<unknown>
  getIntegrationProvider: () => string | null | undefined
  dispatch: Dispatch<ConnectionsPageAction>
}

/** Owns the external OAuth callback effect while page navigation stays declarative. */
export const useConnectionsOAuthCallback = ({
  locationState,
  processMcpCallback,
  processIntegrationCallback,
  getIntegrationProvider,
  dispatch,
}: ConnectionsOAuthCallbackControllerOptions): void => {
  const processedStateRef = useRef<unknown>(null)

  useEffect(() => {
    if (processedStateRef.current === locationState) {
      return
    }
    const callback = getConnectionsOAuthCallback(locationState)
    if (callback.kind === 'none') {
      return
    }
    processedStateRef.current = locationState
    if (callback.kind === 'mcp') {
      void processMcpCallback(callback.callback)
      return
    }

    const process = async () => {
      dispatch({ type: 'processing-callback', processing: true })
      const provider = getIntegrationProvider()
      if (provider) {
        dispatch({ type: 'select', selection: { kind: 'integration', id: provider } })
      }
      try {
        await processIntegrationCallback(callback.callback)
      } catch (error) {
        console.error('Failed to complete OAuth:', error)
      } finally {
        dispatch({ type: 'processing-callback', processing: false })
        dispatch({ type: 'clear-navigation-state' })
      }
    }
    void process()
  }, [dispatch, getIntegrationProvider, locationState, processIntegrationCallback, processMcpCallback])
}
