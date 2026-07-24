/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useEffect, useEffectEvent, useRef, type Dispatch } from 'react'

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
  // Each navigation state must be handled exactly once, even if the effect
  // re-fires for the same state (e.g. StrictMode remounts).
  const processedStateRef = useRef<unknown>(null)
  // The handlers arrive as unstable closures; wrapping them in an effect event
  // keeps the effect keyed on `locationState` alone.
  const handleCallback = useEffectEvent((state: unknown) => {
    if (processedStateRef.current === state) {
      return
    }
    const callback = getConnectionsOAuthCallback(state)
    if (callback.kind === 'none') {
      return
    }
    processedStateRef.current = state
    if (callback.kind === 'mcp') {
      void processMcpCallback(callback.callback)
      return
    }

    const handleIntegrationCallback = async () => {
      dispatch({ type: 'CALLBACK_STARTED' })
      const provider = getIntegrationProvider()
      if (provider) {
        dispatch({ type: 'SELECTION_CHANGED', selection: { kind: 'integration', id: provider } })
      }
      try {
        await processIntegrationCallback(callback.callback)
      } catch (error) {
        console.error('Failed to complete OAuth:', error)
      } finally {
        dispatch({ type: 'CALLBACK_SETTLED' })
        dispatch({ type: 'NAVIGATION_STATE_CONSUMED' })
      }
    }
    void handleIntegrationCallback()
  })

  useEffect(() => {
    handleCallback(locationState)
  }, [locationState])
}
