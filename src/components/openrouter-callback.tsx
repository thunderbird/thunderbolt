/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { ProviderAuthorizationResult } from '@/components/provider-authorization-result'
import { useEffect, useState } from 'react'
import {
  createOpenRouterCallbackChannel,
  openRouterCallbackChannelName,
  readOpenRouterCallback,
} from '@/lib/openrouter-callback'

type OpenRouterCallbackProps = { createChannel?: typeof createOpenRouterCallbackChannel }

/** Relays authorization across COOP-separated windows, without relying on window.opener. */
const OpenRouterCallback = ({ createChannel = createOpenRouterCallbackChannel }: OpenRouterCallbackProps) => {
  const [callback] = useState(() => readOpenRouterCallback(new URL(window.location.href)))

  // BroadcastChannel is an external system; retain only the in-memory callback
  // snapshot while removing the authorization code from browser history.
  useEffect(() => {
    window.history.replaceState(window.history.state, '', window.location.pathname)
    if (!callback) {
      return
    }
    const channel = createChannel(openRouterCallbackChannelName(callback.flowId))
    channel.postMessage(callback.message)
    const closeTimer = setTimeout(() => window.close(), 1000)
    return () => {
      clearTimeout(closeTimer)
      channel.close()
    }
  }, [callback, createChannel])

  const isAuthorized = Boolean(callback && !callback.message.error)
  const isCancelled = callback?.message.error === 'cancelled'

  return <ProviderAuthorizationResult status={isAuthorized ? 'authorized' : isCancelled ? 'cancelled' : 'invalid'} />
}

export default OpenRouterCallback
