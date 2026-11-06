/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useEffect, useEffectEvent, useReducer, useRef, useState } from 'react'
import { useLingui } from '@lingui/react/macro'
import { openUrl } from '@tauri-apps/plugin-opener'
import { useDatabase } from '@/contexts'
import { normalizeOtariConnectionUrl, saveProviderConnection } from '@/dal/provider-connections'
import { getAvailableModels } from '@/dal/models'
import { useChatStore } from '@/chats/chat-store'
import { useQueryClient } from '@tanstack/react-query'
import { getProviderConnectionAttempt, type ProviderConnectionAttempt } from '@/lib/provider-connection-attempt'
import { isMobile, isTauri } from '@/lib/platform'
import {
  startOpenRouterConnection,
  prepareOpenRouterManualConnection,
  exchangeOpenRouterCode,
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
import { getOtariBrowserReturn, clearOtariBrowserReturn, startOtariBrowserConnection } from '@/lib/otari-browser-auth'
import { loadOtariSearchStatus } from '@/integrations/otari-search/capabilities'
import { useSearchProviderStore } from '@/stores/search-provider-store'
import type { ProviderCredentials } from './types'
import { getProviderDefinition } from './registry'

type AuthorizationInput = { provider: 'openrouter' | 'tinfoil' | 'otari'; name: string; url?: string; id?: string }
type Manual = { request: OpenRouterManualConnection; input: AuthorizationInput; attempt: ProviderConnectionAttempt }
type State = { isPending: boolean; error: string | null; manual: Manual | null; code: string }
const draftKey = 'thunderbolt-provider-authorization-draft'
const draftStorage = () => (isTauri() && isMobile() ? localStorage : sessionStorage)

/** Use the authorization origin, keeping the official API hostname out of the sign-in flow. */
const otariOrigin = (url?: string): string => {
  if (!url || url === getOtariEndpoints(defaultOtariOrigin).inference) {
    return defaultOtariOrigin
  }
  const parsed = new URL(normalizeOtariConnectionUrl(url))
  return normalizeOtariOrigin(parsed.origin)
}

/** Authorize a reusable connection without requiring a model or an inference request. */
export const useProviderAuthorization = ({ onConnected }: { onConnected: (id: string) => void }) => {
  const db = useDatabase()
  const queryClient = useQueryClient()
  const { t } = useLingui()
  const [returned] = useState(() => getOtariBrowserReturn('connections') ?? getTinfoilMobileReturn('connections'))
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
    attempt: ProviderConnectionAttempt,
    controller: AbortController,
  ) => {
    controller.signal.throwIfAborted()
    const url = input.provider === 'otari' ? getOtariEndpoints(otariOrigin(input.url)).inference : undefined
    const id = await saveProviderConnection(db, {
      ...input,
      url,
      authMethod: 'oauth',
      credentials,
      attempt,
      signal: controller.signal,
    })
    controller.signal.throwIfAborted()
    if (input.provider === 'tinfoil') {
      useSearchProviderStore.getState().configureProviderSearch(id, 'available', { select: false })
    }
    if (input.provider === 'otari') {
      const status = await loadOtariSearchStatus(
        url!,
        credentials.access_token ?? credentials.apiKey!,
        controller.signal,
      )
      controller.signal.throwIfAborted()
      useSearchProviderStore.getState().configureProviderSearch(id, status, { select: false })
    }
    draftStorage().removeItem(draftKey)
    useChatStore.getState().setModels(await getAvailableModels(db))
    await queryClient.invalidateQueries({ queryKey: ['provider-connections'] })
    await queryClient.invalidateQueries({ queryKey: ['models'] })
    controller.signal.throwIfAborted()
    update({ isPending: false, manual: null, code: '', error: null })
    onConnected(id)
  }

  const fail = (controller: AbortController) => {
    if (!controller.signal.aborted) {
      update({ isPending: false, error: t`Could not connect this provider. Please try again.` })
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
      if (input.provider === 'otari') {
        const origin = otariOrigin(input.url)
        if (!isTauri() || isMobile()) {
          await startOtariBrowserConnection(origin, 'connections', controller.signal, attempt)
          return
        }
        await complete(input, { access_token: await connectOtari(origin, controller.signal) }, attempt, controller)
        return
      }
      if (isTauri() && isMobile()) {
        if (input.provider === 'tinfoil') {
          await startTinfoilMobileConnection('connections', attempt, controller.signal)
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
    } catch {
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
      const key = await exchangeOpenRouterCode(state.code.trim(), state.manual.request.verifier, controller.signal)
      await complete(state.manual.input, { access_token: key }, state.manual.attempt, controller)
    } catch {
      fail(controller)
    }
  }

  return {
    authorize,
    isPending: state.isPending,
    error: state.error,
    cancel: () => {
      pending.current?.abort()
      returned?.cancel()
      cancelTinfoilMobileConnection()
      draftStorage().removeItem(draftKey)
      update({ isPending: false, error: null, manual: null, code: '' })
    },
    manual: state.manual ? { code: state.code, setCode: (code: string) => update({ code }), submit } : null,
  }
}
