/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

export type OpenRouterCallbackMessage = {
  type: 'openrouter-callback'
  state: string
} & ({ code: string; error?: never } | { error: 'cancelled' | 'invalid_response'; code?: never })

export type OpenRouterCallbackChannel = {
  onmessage: ((event: MessageEvent<unknown>) => void) | null
  postMessage: (message: unknown) => void
  close: () => void
}

export type OpenRouterCallback = { flowId: string; message: OpenRouterCallbackMessage }

/** The unguessable per-flow channel survives COOP severing the popup's opener. */
export const openRouterCallbackChannelName = (flowId: string): string => `thunderbolt-openrouter-${flowId}`

/** Opens a same-origin channel without persisting the callback or PKCE verifier. */
export const createOpenRouterCallbackChannel = (name: string): OpenRouterCallbackChannel => new BroadcastChannel(name)

/** Validates the callback's path nonce and strips provider error details before relaying it. */
export const readOpenRouterCallback = (url: URL): OpenRouterCallback | null => {
  const flowId =
    url.pathname === '/oauth/tinfoil'
      ? /^[A-Za-z0-9_-]{43}$/.test(url.searchParams.get('state') ?? '')
        ? url.searchParams.get('state')!
        : null
      : /^\/oauth\/(?:openrouter|tinfoil)\/([A-Za-z0-9_-]{43})\/?$/.exec(url.pathname)?.[1]
  if (!flowId) {
    return null
  }
  const code = url.searchParams.get('code')
  const state = url.searchParams.get('state')
  const error = url.searchParams.get('error') || url.searchParams.get('error_description')
  if (error) {
    // OpenRouter omits state on denial; the secret callback path still identifies
    // the pending channel. Never forward the provider's arbitrary error text.
    return { flowId, message: { type: 'openrouter-callback', state: flowId, error: 'cancelled' } }
  }
  if (!code?.trim() || state !== flowId) {
    return { flowId, message: { type: 'openrouter-callback', state: flowId, error: 'invalid_response' } }
  }
  return { flowId, message: { type: 'openrouter-callback', state, code } }
}
