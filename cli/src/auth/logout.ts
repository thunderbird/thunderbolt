/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { toError } from '@earendil-works/pi-agent-core'
import { isProviderRuntimeError, providerRuntimeError } from '../provider-runtime/types.ts'
import type { AccountFetch, CliAuth, DeviceGrantPresentation, ProviderRuntimeError } from '../provider-runtime/types.ts'
import { apiBaseUrl, backendHeaders, patRemainsActiveNote } from './config.ts'
import type { CompareAndSetAuth } from './token-store.ts'

export type LogoutResult = 'logged-out' | 'pat-managed-externally' | 'authentication-required'

export type ConfirmedLogoutPersistenceError = Error &
  ProviderRuntimeError & {
    readonly remoteLogoutConfirmed: true
    readonly authenticationRequired?: true
  }

export type LogoutDeps = {
  readonly auth: CliAuth | null
  readonly patToken?: string
  readonly fetchFn?: AccountFetch
  readonly compareAndSetAuth: CompareAndSetAuth
  readonly presentation: DeviceGrantPresentation
  readonly signal?: AbortSignal
}

/** Creates a stable provider-runtime error for an ambiguous logout failure. */
const createLogoutError = (
  code: ProviderRuntimeError['code'],
  message: string,
): Error & ProviderRuntimeError => providerRuntimeError(code, message)

/** Identifies a local persistence failure after the server definitively revoked the CLI session. */
export const isConfirmedLogoutPersistenceError = (error: Error): error is ConfirmedLogoutPersistenceError =>
  isProviderRuntimeError(error, 'persistence-failed') &&
  'remoteLogoutConfirmed' in error &&
  error.remoteLogoutConfirmed === true

/** Preserves the confirmed remote result while making the local cleanup failure actionable. */
const createConfirmedLogoutPersistenceError = (
  error: Error,
  authenticationRequired: boolean = false,
): ConfirmedLogoutPersistenceError => {
  const message = authenticationRequired
    ? `Thunderbolt rejected the stored session, but local authentication state could not be updated: ${error.message}`
    : `Remote logout succeeded, but local authentication state could not be cleared: ${error.message}`
  return Object.assign(createLogoutError('persistence-failed', message), {
    remoteLogoutConfirmed: true as const,
    authenticationRequired: authenticationRequired ? (true as const) : undefined,
  })
}

/** Performs remote-first CLI-device logout without retries or local-first mutation. */
export const performLogout = async (deps: LogoutDeps): Promise<LogoutResult> => {
  if (deps.auth === null || deps.auth.registration === 'authentication-required') {
    if (deps.patToken) {
      deps.presentation.showStatus(
        'error',
        'THUNDERBOLT_TOKEN is managed by the environment and cannot be cleared by the CLI.',
      )
      return 'pat-managed-externally'
    }
    deps.presentation.showStatus('error', 'No stored Thunderbolt web session is available to log out.')
    return 'authentication-required'
  }

  const auth = deps.auth
  const backendUrl = apiBaseUrl(auth.backendUrl)

  deps.presentation.showStatus('waiting', 'Revoking this Thunderbolt CLI device…')
  const fetchFn = deps.fetchFn ?? fetch
  const response = await (async (): Promise<Response> => {
    try {
      return await fetchFn(`${backendUrl}/account/devices/cli/logout`, {
        method: 'POST',
        headers: backendHeaders({ Authorization: `Bearer ${auth.bearer}` }),
        redirect: 'error',
        signal: deps.signal,
      })
    } catch (error) {
      if (deps.signal?.aborted) throw error
      const failure = createLogoutError('network', toError(error).message)
      deps.presentation.showStatus('error', failure.message)
      throw failure
    }
  })()

  if (response.status === 204) {
    try {
      await deps.compareAndSetAuth({ kind: 'installation', auth }, null)
    } catch (error) {
      const failure = createConfirmedLogoutPersistenceError(toError(error))
      deps.presentation.showStatus('error', failure.message)
      throw failure
    }
    const message = deps.patToken ? `Web session logged out. ${patRemainsActiveNote}` : 'Logout successful.'
    deps.presentation.showStatus('success', message)
    return 'logged-out'
  }

  if (response.status === 401) {
    try {
      await deps.compareAndSetAuth(
        { kind: 'exact', auth },
        { ...auth, registration: 'authentication-required', bearer: null },
      )
    } catch (error) {
      const failure = createConfirmedLogoutPersistenceError(toError(error), true)
      deps.presentation.showStatus('error', failure.message)
      throw failure
    }
    deps.presentation.showStatus('error', 'The stored Thunderbolt session is no longer valid. Log in again to continue.')
    return 'authentication-required'
  }

  const failure = createLogoutError(
    response.status >= 500 ? 'network' : 'authentication-rejected',
    `Thunderbolt logout failed (${response.status} ${response.statusText})`,
  )
  deps.presentation.showStatus('error', failure.message)
  throw failure
}
