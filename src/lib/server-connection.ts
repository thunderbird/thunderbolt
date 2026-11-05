/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useConfigStore, type AppConfig } from '@/api/config-store'
import { clearAuthToken, getAuthToken } from '@/lib/auth-token'
import { fetch } from '@/lib/fetch'
import { createClient, type HttpClient } from '@/lib/http'
import { clearCachedSession, getCachedSession } from '@/lib/session-cache'
import { getLocalSetting, isCurrentServer, useLocalSettingsStore } from '@/stores/local-settings-store'
import { appVersionHeader, isVersionBelowMinimum } from '@/lib/app-version'

/** A candidate server needs a newer client; the current connection remains unchanged. */
export class ServerVersionUnsupportedError extends Error {
  constructor() {
    super('Update Thunderbolt before connecting to this server')
    this.name = 'ServerVersionUnsupportedError'
  }
}

/** Only a server that has never owned an account or synced data can be changed in place. */
export const canChangeServer = (): boolean =>
  isCurrentServer(getLocalSetting('cloudUrl')) &&
  !!getLocalSetting('cloudUrl') &&
  getLocalSetting('localMode') &&
  !getLocalSetting('serverHasAuthenticated') &&
  !getLocalSetting('syncEnabled') &&
  !getAuthToken() &&
  !getCachedSession()?.user

/** Forget an unused server without touching local chats, providers, or device data. */
export const disconnectUnclaimedServer = (): void => {
  if (!canChangeServer()) {
    throw new Error('This server has account data and cannot be changed without resetting local data')
  }
  clearAuthToken()
  clearCachedSession()
  useConfigStore.setState({ config: {}, configLoaded: true, forceUpgrade: false, forceUpgradeMinVersion: undefined })
  useLocalSettingsStore.setState({ cloudUrl: '', serverHasAuthenticated: false })
}

/** Accept a server origin or API base, without URL credentials, queries, or fragments. */
export const normalizeServerUrl = (input: string): string => {
  const url = new URL(input.trim())
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('Enter an HTTP or HTTPS server URL without credentials, a query, or a fragment')
  }
  const path = url.pathname.replace(/\/+$/, '')
  url.pathname = path.endsWith('/v1') ? path : `${path}/v1`
  return url.toString().replace(/\/+$/, '')
}

/** Validate the public endpoint before selecting a server; never send an existing session to the candidate. */
export const connectToServer = async (input: string, client?: HttpClient, signal?: AbortSignal): Promise<void> => {
  signal?.throwIfAborted()
  const cloudUrl = normalizeServerUrl(input)
  const previousUrl = getLocalSetting('cloudUrl')
  if (!isCurrentServer(previousUrl)) {
    throw new Error('The selected server changed in another window')
  }
  if (previousUrl && previousUrl !== cloudUrl) {
    throw new Error('Disconnect the current account before changing servers')
  }
  const httpClient = client ?? createClient({ prefixUrl: cloudUrl, fetch, credentials: 'omit' })
  const config = await httpClient.get('config', { timeout: 5_000, signal }).json<AppConfig>()
  signal?.throwIfAborted()
  if (
    !config ||
    typeof config !== 'object' ||
    Array.isArray(config) ||
    typeof config.builtInAgentEnabled !== 'boolean'
  ) {
    throw new Error('This URL did not return a Thunderbolt server configuration')
  }
  if (isVersionBelowMinimum(appVersionHeader()['X-App-Version'], config.minAppVersion)) {
    throw new ServerVersionUnsupportedError()
  }
  if (!isCurrentServer(previousUrl)) {
    throw new Error('The selected server changed while connecting')
  }
  if (!previousUrl) {
    clearAuthToken()
    clearCachedSession()
  }
  useConfigStore.setState({ config, configLoaded: true, forceUpgrade: false, forceUpgradeMinVersion: undefined })
  useLocalSettingsStore.setState({
    cloudUrl,
    localMode: useLocalSettingsStore.getState().localMode || !previousUrl,
    serverHasAuthenticated: previousUrl ? getLocalSetting('serverHasAuthenticated') : false,
  })
}
