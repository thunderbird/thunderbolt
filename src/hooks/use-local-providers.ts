/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useSyncExternalStore } from 'react'
import { subscribeAuthToken } from '@/lib/auth-token'
import { hasServerAuthentication, usesLocalProviders } from '@/lib/provider-mode'
import { subscribeCachedSession } from '@/lib/session-cache'
import { useLocalSettingsStore } from '@/stores/local-settings-store'

/** Observes bearer authentication and cookie-backed SSO without requiring an auth provider. */
const subscribeProviderAuthentication = (listener: () => void): (() => void) => {
  const unsubscribeToken = subscribeAuthToken(listener)
  const unsubscribeSession = subscribeCachedSession(listener)
  return () => {
    unsubscribeToken()
    unsubscribeSession()
  }
}

/** Reactively follows the same authentication policy used by non-React model and tool calls. */
export const useLocalProviders = (): boolean => {
  const cloudUrl = useLocalSettingsStore((state) => state.cloudUrl)
  const localMode = useLocalSettingsStore((state) => state.localMode)
  const authenticated = useSyncExternalStore(subscribeProviderAuthentication, hasServerAuthentication)
  return usesLocalProviders(cloudUrl, localMode, authenticated)
}
