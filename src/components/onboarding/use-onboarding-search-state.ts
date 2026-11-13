/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useEffect, useEffectEvent, useReducer, useRef } from 'react'
import { useLocation } from 'react-router'
import { useSearchProviderAvailability } from '@/integrations/standalone-search/use-search-provider-availability'
import { isSearchProvider, searchProviders } from '@/integrations/standalone-search/providers'
import { canSupplySearch } from '@/integrations/standalone-search/eligibility'
import { useSearchProviderStore } from '@/stores/search-provider-store'
import { useProviderAuthorization } from '@/providers/use-provider-authorization'
import { isOnboardingSearchAuthorization } from '@/providers/authorization-draft'
import { getConnectionsOAuthCallback } from '@/settings/connections/oauth-callback'
import { getMcpOAuthState } from '@/lib/mcp-auth/mcp-oauth-state'
import { getMcpSearchProvider } from '@/providers/mcp-search-auth'
import { useAiProviderConnections } from '@/settings/connections/use-ai-provider-connections'

export type OnboardingSearchStepProps = {
  onBack?: () => void
  onContinue?: () => void
  onSkip?: () => void
}
type State = { selection: string | null; view: 'choices' | 'connect' | 'ready' }

/** Share Connections authorization while keeping search setup inside onboarding. */
export const useOnboardingSearchState = ({ onContinue }: OnboardingSearchStepProps) => {
  const stored = useSearchProviderStore()
  const connectionControls = useAiProviderConnections()
  const { connections, configuredConnections, otariEnabled } = useSearchProviderAvailability()
  const available = connections.filter(canSupplySearch)
  const [state, update] = useReducer((state: State, patch: Partial<State>): State => ({ ...state, ...patch }), {
    selection: stored.selection === 'connection' ? stored.connectionId : null,
    view: 'choices',
  })
  const saved = (id: string) => {
    stored.selectSearchConnection(id)
    update({ selection: id, view: 'ready' })
  }
  const authorization = useProviderAuthorization({ onConnected: saved, resumeReturn: false })
  const location = useLocation()
  const processed = useRef<unknown>(null)
  const resume = useEffectEvent((routerState: unknown) => {
    if (processed.current === routerState || !isOnboardingSearchAuthorization()) {
      return
    }
    const callback = getConnectionsOAuthCallback(routerState)
    if (callback.kind !== 'mcp') {
      return
    }
    const provider = getMcpSearchProvider(getMcpOAuthState().serverId)
    if (!provider) {
      return
    }
    processed.current = routerState
    update({ selection: provider, view: 'connect' })
    void authorization.processMcpCallback(callback.callback)
  })
  // OAuth redirects deliver an external authorization response on mount.
  useEffect(() => {
    let active = true
    // StrictMode replays mount effects; only the live setup may consume the single-use callback.
    queueMicrotask(() => {
      if (active) {
        resume(location.state)
      }
    })
    return () => {
      active = false
    }
  }, [location.state])
  const provider = state.selection && isSearchProvider(state.selection) ? state.selection : null
  const connected = configuredConnections.find(({ id }) => id === state.selection)
  const providerChoices = Object.keys(searchProviders)
    .filter(isSearchProvider)
    .map((provider) => {
      const existing =
        available.find((connection) => connection.provider === provider && connection.id === state.selection) ??
        available.find((connection) => connection.provider === provider)
      return {
        provider,
        id: existing?.id ?? provider,
        name: existing?.name ?? searchProviders[provider].name,
        connected: Boolean(existing),
      }
    })
  const choices = [
    ...available
      .filter((connection) => !isSearchProvider(connection.provider))
      .map((connection) => ({
        provider: connection.provider,
        id: connection.id,
        name: connection.name,
        connected: true,
      })),
    ...providerChoices,
  ]
  const choose = (selection: string) => {
    authorization.cancel()
    update({ selection, view: 'choices' })
  }
  const back = () => {
    authorization.cancel()
    update({ view: 'choices' })
  }
  const selectedConnection = available.find(({ id }) => id === state.selection)
  const continueSetup = () => {
    if (selectedConnection) {
      stored.selectSearchConnection(selectedConnection.id)
      onContinue?.()
    } else if (provider) {
      update({ view: 'connect' })
    }
  }
  return {
    ...state,
    stored,
    otariEnabled,
    choices,
    connected,
    connectionControls,
    provider,
    saved,
    choose,
    back,
    continueSetup,
    canContinue:
      !authorization.isPending &&
      !connectionControls.pending &&
      Boolean(selectedConnection || (state.view === 'choices' && provider)),
    authorization: {
      ...authorization,
      authorize: (input: Parameters<typeof authorization.authorize>[0]) =>
        authorization.authorize({ ...input, purpose: 'onboarding-search' }),
    },
  }
}
