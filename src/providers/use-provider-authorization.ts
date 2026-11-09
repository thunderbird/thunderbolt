/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import {
  providerAuthorizationDraftKey as draftKey,
  providerAuthorizationDraftStorage as draftStorage,
} from './authorization-draft'
import { useEffect, useEffectEvent, useReducer, useRef, useState } from 'react'
import { useLingui } from '@lingui/react/macro'
import { openUrl } from '@tauri-apps/plugin-opener'
import { useDatabase } from '@/contexts'
import {
  normalizeOtariConnectionUrl,
  getProviderConnection,
  resolveProviderConnection,
  saveProviderConnectionWithRevision,
} from '@/dal/provider-connections'
import { getAvailableModels } from '@/dal/models'
import { useChatStore } from '@/chats/chat-store'
import { useQueryClient } from '@tanstack/react-query'
import {
  assertProviderConnectionAttemptCurrent,
  getProviderConnectionAttempt,
  type ProviderConnectionAttempt,
} from '@/lib/provider-connection-attempt'
import {
  cancelProviderBrowserConnection,
  startProviderBrowserConnection,
  getProviderBrowserReturn,
  clearProviderBrowserReturn,
} from '@/lib/provider-browser-auth'
import { isMobile, isTauri } from '@/lib/platform'
import {
  startOpenRouterConnection,
  prepareOpenRouterManualConnection,
  exchangeOpenRouterCode,
  createOAuthRequestSignal,
  type OpenRouterManualConnection,
} from '@/lib/openrouter-auth'
import { tinfoilAuth } from '@/lib/tinfoil-auth'
import {
  getTinfoilMobileReturn,
  clearTinfoilMobileReturn,
  startTinfoilMobileConnection,
  cancelTinfoilMobileConnection,
} from '@/lib/tinfoil-mobile-auth'
import { connectOtari, defaultOtariOrigin, getOtariEndpoints, normalizeOtariOrigin } from '@/lib/otari-auth'
import {
  getOtariBrowserReturn,
  clearOtariBrowserReturn,
  startOtariBrowserConnection,
  cancelOtariBrowserConnection,
} from '@/lib/otari-browser-auth'
import { loadOtariSearchStatus } from '@/integrations/otari-search/capabilities'
import { useSearchProviderStore } from '@/stores/search-provider-store'
import { connectChatGPT, discardChatGPTAuthorization, ChatGPTCleanupError } from './chatgpt-auth'
import { startMcpOAuthFlow, completeMcpOAuthFlow } from '@/lib/mcp-auth/web-oauth-flow'
import { getMcpOAuthState, clearMcpOAuthState } from '@/lib/mcp-auth/mcp-oauth-state'
import type { McpOAuthCallback } from '@/hooks/use-mcp-server-oauth'
import { getMcpSearchProvider, searchMcpUrls, searchOAuthFetch, mcpSearchCredentials } from './mcp-search-auth'
import type { ProviderCredentials, OAuthProviderType } from './types'
import { getProviderDefinition } from './registry'
import { getProviderConnectionRevision } from './revision'

type AuthorizationInput = {
  purpose?: 'onboarding-search'
  provider: OAuthProviderType
  name: string
  url?: string
  id?: string
  chatGPTAccountId?: string | null
}
type Manual = {
  request: OpenRouterManualConnection
  input: AuthorizationInput
  attempt: ProviderConnectionAttempt<OAuthProviderType>
}
type State = { isPending: boolean; error: string | null; manual: Manual | null; code: string }
/** Draft cleanup must not prevent cancellation or hide an already saved connection. */
const clearAuthorizationDraft = () => {
  try {
    draftStorage().removeItem(draftKey)
    if (getMcpSearchProvider(getMcpOAuthState().serverId)) {
      clearMcpOAuthState()
    }
  } catch {
    // Persistence is required to start a redirect, but removal is best-effort.
  }
}

/** Use the authorization origin, keeping the official API hostname out of the sign-in flow. */
const otariOrigin = (url?: string): string => {
  if (!url || url === getOtariEndpoints(defaultOtariOrigin).inference) {
    return defaultOtariOrigin
  }
  const parsed = new URL(normalizeOtariConnectionUrl(url))
  return normalizeOtariOrigin(parsed.origin)
}

/** Read the pending handoff without consuming it; the connection surface owns completion. */
export const getProviderAuthorizationReturn = () =>
  getProviderBrowserReturn('connections') ??
  getOtariBrowserReturn('connections') ??
  getTinfoilMobileReturn('connections')

/** Authorize a reusable connection without requiring a model or an inference request. */
export const useProviderAuthorization = ({
  onConnected,
  resumeReturn = true,
}: {
  onConnected: (id: string) => void
  resumeReturn?: boolean
}) => {
  const db = useDatabase()
  const queryClient = useQueryClient()
  const { t } = useLingui()
  const [returned] = useState(() => (resumeReturn ? getProviderAuthorizationReturn() : null))
  const [state, update] = useReducer((state: State, change: Partial<State>) => ({ ...state, ...change }), {
    isPending: Boolean(returned),
    error: null,
    manual: null,
    code: '',
  })
  const pending = useRef<AbortController | null>(null)

  const complete = async (
    input: AuthorizationInput,
    credentials: ProviderCredentials,
    attempt: ProviderConnectionAttempt<OAuthProviderType>,
    controller: AbortController,
  ) => {
    controller.signal.throwIfAborted()
    const url = input.provider === 'otari' ? getOtariEndpoints(otariOrigin(input.url)).inference : undefined
    const existing = await getProviderConnection(db, `oauth:${input.provider}`)
    const { id, revision } = await saveProviderConnectionWithRevision(db, {
      ...input,
      url,
      authMethod: 'oauth',
      credentials,
      enabled: existing?.enabled !== 0,
      attempt,
      signal: controller.signal,
    })
    controller.signal.throwIfAborted()
    const assertCurrent = async () => {
      const current = await getProviderConnectionRevision(db, id)
      controller.signal.throwIfAborted()
      if (current !== revision) {
        throw new Error('Provider connection changed after authorization')
      }
    }
    await assertCurrent()
    if (input.provider === 'tinfoil') {
      useSearchProviderStore.getState().configureProviderSearch(id, 'available', { select: false })
    }
    if (input.provider === 'otari' && existing?.enabled !== 0) {
      const resolved = await resolveProviderConnection(db, id)
      if (resolved.connection.url !== url || resolved.apiKey !== (credentials.access_token ?? credentials.apiKey)) {
        throw new Error('Provider connection changed after authorization')
      }
      controller.signal.throwIfAborted()
      const status = await loadOtariSearchStatus(
        resolved.connection.url!,
        resolved.apiKey,
        createOAuthRequestSignal(controller.signal),
      )
      await assertCurrent()
      useSearchProviderStore.getState().configureProviderSearch(id, status, { select: false })
    }
    clearAuthorizationDraft()
    useChatStore.getState().setModels(await getAvailableModels(db))
    await queryClient.invalidateQueries({ queryKey: ['provider-connections'] })
    await queryClient.invalidateQueries({ queryKey: ['models'] })
    await assertCurrent()
    update({ isPending: false, manual: null, code: '', error: null })
    if (input.purpose === 'onboarding-search') {
      useSearchProviderStore.getState().selectSearchConnection(id)
    }
    onConnected(id)
  }

  const fail = (controller: AbortController, error?: unknown) => {
    if (!controller.signal.aborted) {
      update({
        isPending: false,
        error:
          error instanceof ChatGPTCleanupError
            ? t`Could not finish connecting or revoke the unused session. You can remove Thunderbolt’s access in ChatGPT Settings.`
            : t`Could not connect this provider. Please try again.`,
      })
    }
  }

  const resume = useEffectEvent(async (controller: AbortController) => {
    if (!returned) {
      return
    }
    try {
      const provider = returned.attempt.provider
      const raw = draftStorage().getItem(draftKey)
      const draft: AuthorizationInput | null = raw ? JSON.parse(raw) : null
      // The validated OAuth return owns routing, never the editable draft.
      const input: AuthorizationInput = {
        provider,
        name: draft?.provider === provider ? draft.name : getProviderDefinition(provider).name,
        ...('origin' in returned ? { url: returned.origin } : {}),
      }
      await assertProviderConnectionAttemptCurrent(db, returned.attempt)
      controller.signal.throwIfAborted()
      const result = await returned.complete()
      await complete(
        input,
        typeof result === 'string' ? { access_token: result } : result,
        returned.attempt,
        controller,
      )
    } catch {
      fail(controller)
    }
  })

  // Authorization owns external browser/native listeners; cleanup cancels in-memory work only.
  useEffect(() => {
    if (returned) {
      clearProviderBrowserReturn(returned.id)
      if ('origin' in returned) {
        clearOtariBrowserReturn(returned.id)
      } else {
        clearTinfoilMobileReturn(returned.id)
      }
      const controller = new AbortController()
      pending.current = controller
      void resume(controller)
    }
    return () => pending.current?.abort()
  }, [returned])

  const authorize = async (input: AuthorizationInput) => {
    pending.current?.abort()
    const controller = new AbortController()
    pending.current = controller
    update({ isPending: true, error: null, manual: null, code: '' })
    try {
      const attempt = await getProviderConnectionAttempt(db, input.provider)
      controller.signal.throwIfAborted()
      draftStorage().setItem(draftKey, JSON.stringify(input))
      if (input.provider === 'exa' || input.provider === 'tavily') {
        const provider = input.provider
        draftStorage().setItem(draftKey, JSON.stringify({ ...input, attempt }))
        await startMcpOAuthFlow({
          db,
          serverId: `oauth:${provider}`,
          serverUrl: searchMcpUrls[provider],
          signal: controller.signal,
          fetchFn: searchOAuthFetch(controller.signal),
          saveCredentials: (credentials) =>
            complete(input, mcpSearchCredentials(provider, credentials), attempt, controller),
        })
        return
      }
      if (input.provider === 'openai') {
        const credentials = await connectChatGPT(db, controller.signal, undefined, input.chatGPTAccountId)
        try {
          await complete({ ...input, name: input.id ? input.name : 'ChatGPT' }, credentials, attempt, controller)
        } catch (error) {
          await discardChatGPTAuthorization(db, credentials)
          throw error
        }
        return
      }
      const redirectAttempt = { ...attempt, provider: input.provider }
      if (input.provider === 'otari') {
        const origin = otariOrigin(input.url)
        if (!isTauri() || isMobile()) {
          await startOtariBrowserConnection(origin, 'connections', controller.signal, redirectAttempt)
          return
        }
        await complete(input, { access_token: await connectOtari(origin, controller.signal) }, attempt, controller)
        return
      }
      if (!isTauri()) {
        await startProviderBrowserConnection(input.provider, 'connections', redirectAttempt, controller.signal)
        return
      }
      if (isMobile()) {
        if (input.provider === 'tinfoil') {
          await startTinfoilMobileConnection('connections', redirectAttempt, controller.signal)
        } else {
          const request = await prepareOpenRouterManualConnection()
          controller.signal.throwIfAborted()
          await openUrl(request.authorizationUrl)
          controller.signal.throwIfAborted()
          update({ manual: { request, input, attempt }, isPending: false })
        }
        return
      }
      const credentials =
        input.provider === 'tinfoil'
          ? await tinfoilAuth.startConnection({ signal: controller.signal })
          : { access_token: await startOpenRouterConnection({ signal: controller.signal }) }
      await complete(input, credentials, attempt, controller)
    } catch (error) {
      fail(controller, error)
    } finally {
      if (input.provider === 'openai') {
        useChatStore.getState().setModels(await getAvailableModels(db))
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: ['chatgpt-accounts'] }),
          queryClient.invalidateQueries({ queryKey: ['provider-connections'] }),
          queryClient.invalidateQueries({ queryKey: ['models'] }),
        ])
      }
    }
  }

  const processMcpCallback = async (callback: McpOAuthCallback): Promise<void> => {
    const provider = getMcpSearchProvider(getMcpOAuthState().serverId)
    if (!provider) {
      return
    }
    const controller = new AbortController()
    pending.current = controller
    update({ isPending: true, error: null })
    try {
      const raw = draftStorage().getItem(draftKey)
      const draft = raw
        ? (JSON.parse(raw) as AuthorizationInput & { attempt: ProviderConnectionAttempt<OAuthProviderType> })
        : null
      if (
        !draft ||
        draft.provider !== provider ||
        !draft.attempt ||
        draft.attempt.provider !== provider ||
        callback.error ||
        !callback.code
      ) {
        clearMcpOAuthState()
        throw new Error('Authorization was cancelled or expired')
      }
      await assertProviderConnectionAttemptCurrent(db, draft.attempt)
      await completeMcpOAuthFlow({
        db,
        serverId: `oauth:${provider}`,
        code: callback.code,
        returnedState: callback.state,
        returnedIss: callback.iss,
        fetchFn: searchOAuthFetch(controller.signal),
        saveCredentials: (credentials) =>
          complete(draft, mcpSearchCredentials(provider, credentials), draft.attempt, controller),
      })
    } catch {
      clearMcpOAuthState()
      fail(controller)
    }
  }

  const submit = async () => {
    if (!state.manual || !state.code.trim() || state.isPending) {
      return
    }
    const controller = new AbortController()
    pending.current = controller
    update({ isPending: true, error: null })
    try {
      await assertProviderConnectionAttemptCurrent(db, state.manual.attempt)
      controller.signal.throwIfAborted()
      const key = await exchangeOpenRouterCode(state.code.trim(), state.manual.request.verifier, controller.signal)
      await complete(state.manual.input, { access_token: key }, state.manual.attempt, controller)
    } catch {
      fail(controller)
    }
  }

  return {
    authorize,
    processMcpCallback,
    isPending: state.isPending,
    error: state.error,
    cancel: () => {
      pending.current?.abort()
      returned?.cancel()
      cancelProviderBrowserConnection()
      cancelOtariBrowserConnection()
      cancelTinfoilMobileConnection()
      clearAuthorizationDraft()
      update({ isPending: false, error: null, manual: null, code: '' })
    },
    manual: state.manual ? { code: state.code, setCode: (code: string) => update({ code }), submit } : null,
  }
}
