/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { randomBytes, randomUUID } from 'node:crypto'
import { toError } from '@earendil-works/pi-agent-core'
import { abortable } from '../lib/abort.ts'
import { isRecord } from '../lib/json.ts'
import type {
  AccountActions,
  AccountFetch,
  CliAuth,
  ProviderRuntimeError,
  SessionCredential,
} from '../provider-runtime/types.ts'
import { providerRuntimeError } from '../provider-runtime/types.ts'
import { apiBaseUrl, authBaseUrl, backendHeaders } from './config.ts'
import { systemClock } from './device-grant.ts'
import { createHttpTransport } from './http-transport.ts'
import { createTerminalQrBlock, performLogin } from './login.ts'
import { performLogout } from './logout.ts'
import { compareAndSetAuthConfig, loadAuthConfig, toAuth, type AuthStateExpectation } from './token-store.ts'

type AccountClientError = Error & ProviderRuntimeError

export type CliDeviceMetadata = {
  readonly deviceName: string
}

export type AccountActionDependencies = {
  readonly backendUrl: string
  readonly metadata: CliDeviceMetadata
  readonly fetchFn?: AccountFetch
  readonly patToken?: string
}

const defaultRegistrationTimeoutMs = 10_000

/** Creates a stable provider-runtime error for account lifecycle failures. */
const createAccountClientError = (code: ProviderRuntimeError['code'], message: string): AccountClientError =>
  providerRuntimeError(code, message)

/** Creates or reuses the installation that is current after web approval completes. */
const createSessionCredential = (backendUrl: string, bearer: string, stored: CliAuth | null): SessionCredential => {
  if (stored !== null && apiBaseUrl(stored.backendUrl) === backendUrl) {
    return {
      type: 'session',
      backendUrl,
      bearer,
      deviceId: stored.deviceId,
      userCacheSecret: Uint8Array.from(Buffer.from(stored.userCacheSecret, 'hex')),
    }
  }
  return {
    type: 'session',
    backendUrl,
    bearer,
    deviceId: `cli-${randomUUID()}`,
    userCacheSecret: randomBytes(32),
  }
}

/** Reads a JSON response while treating malformed JSON as no usable body. */
const jsonBodyOrNull = async (response: Response): Promise<unknown | null> => {
  try {
    return (await response.json()) as unknown
  } catch (error) {
    if (error instanceof SyntaxError) return null
    throw error
  }
}

/** Identifies server responses that require a fresh local installation identity. */
const installationConflict = async (response: Response): Promise<'device-disconnected' | 'device-id-taken' | null> => {
  const body = await jsonBodyOrNull(response)
  if (!isRecord(body)) return null
  if (response.status === 403 && body.code === 'DEVICE_DISCONNECTED') return 'device-disconnected'
  if (response.status === 409 && body.code === 'DEVICE_ID_TAKEN') return 'device-id-taken'
  return null
}

/** Creates a fresh installation identity after a conflicting or revoked response. */
const rotateInstallation = (credential: SessionCredential): SessionCredential => ({
  ...credential,
  deviceId: `cli-${randomUUID()}`,
  userCacheSecret: randomBytes(32),
})

/** Checks whether durable auth already owns the installation being touched. */
const ownsInstallation = (auth: CliAuth | null, credential: SessionCredential): auth is CliAuth =>
  auth !== null &&
  auth.deviceId === credential.deviceId &&
  auth.userCacheSecret === Buffer.from(credential.userCacheSecret).toString('hex') &&
  apiBaseUrl(auth.backendUrl) === apiBaseUrl(credential.backendUrl)

/** Sends one bodyless register/touch request for a session installation. */
const registerSession = async (
  credential: SessionCredential,
  metadata: CliDeviceMetadata,
  request: AccountFetch,
  signal?: AbortSignal,
): Promise<Response> => {
  const backendUrl = apiBaseUrl(credential.backendUrl)

  try {
    signal?.throwIfAborted()
    return await abortable(
      request(`${backendUrl}/account/devices/cli`, {
        method: 'PUT',
        headers: backendHeaders({
          Authorization: `Bearer ${credential.bearer}`,
          'X-Device-ID': credential.deviceId,
          'X-Device-Name': metadata.deviceName,
        }),
        redirect: 'error',
        signal,
      }),
      signal,
    )
  } catch (error) {
    signal?.throwIfAborted()
    throw createAccountClientError('network', toError(error).message)
  }
}

/** Verifies the exact successful registration response before enabling use. */
const isRegisteredResponse = async (response: Response, credential: SessionCredential): Promise<boolean> => {
  if (response.status !== 200) return false
  const body = await jsonBodyOrNull(response)
  return isRecord(body) && body.deviceId === credential.deviceId && body.state === 'registered'
}

/**
 * Registers or touches a session-backed CLI installation before managed use.
 * A conflicting or revoked installation identity is rotated and retried exactly once.
 */
export const ensureRegisteredSession = async (
  credential: SessionCredential,
  metadata: CliDeviceMetadata,
  fetchFn: AccountFetch = fetch as AccountFetch,
  signal?: AbortSignal,
  existingAuth?: CliAuth | null,
): Promise<SessionCredential> => {
  apiBaseUrl(credential.backendUrl)
  signal?.throwIfAborted()
  const durableAuth = existingAuth === undefined ? await loadAuthConfig() : existingAuth
  signal?.throwIfAborted()
  // Bun may release an AbortSignal.timeout timer when sequential races briefly have no listener.
  const retainDeadline = (): void => {}
  signal?.addEventListener('abort', retainDeadline, { once: true })

  const ensure = async (
    current: SessionCredential,
    rotated: boolean,
    durableAuth: CliAuth | null,
  ): Promise<SessionCredential> => {
    /** Applies one durable state transition only while its expected predecessor is still current. */
    const persistAuth = async (expected: AuthStateExpectation, auth: CliAuth): Promise<void> => {
      const changed = await compareAndSetAuthConfig(expected, auth)
      signal?.throwIfAborted()
      if (changed) return
      throw createAccountClientError(
        'authentication-required',
        'Thunderbolt authentication changed during device registration. Retry the command.',
      )
    }
    const attemptAuth = ownsInstallation(durableAuth, current)
      ? durableAuth
      : toAuth(current, 'authentication-required')
    if (attemptAuth !== durableAuth) await persistAuth({ kind: 'exact', auth: durableAuth }, attemptAuth)
    const expectedAuth = attemptAuth
    signal?.throwIfAborted()

    const response = await registerSession(current, metadata, fetchFn, signal)
    signal?.throwIfAborted()

    if (await abortable(isRegisteredResponse(response, current), signal)) {
      signal?.throwIfAborted()
      await persistAuth({ kind: 'exact', auth: expectedAuth }, toAuth(current, 'registered'))
      return current
    }

    if (response.status === 401) {
      await persistAuth({ kind: 'exact', auth: expectedAuth }, toAuth(current, 'authentication-required'))
      throw createAccountClientError('authentication-required', 'the stored Thunderbolt session is no longer valid')
    }

    const conflict =
      response.status === 403 || response.status === 409
        ? await abortable(installationConflict(response), signal)
        : null
    if (conflict !== null) {
      if (!rotated) return ensure(rotateInstallation(current), true, expectedAuth)
      await persistAuth({ kind: 'exact', auth: expectedAuth }, toAuth(current, 'authentication-required'))
      if (conflict === 'device-disconnected') {
        throw createAccountClientError('device-disconnected', 'the Thunderbolt CLI device was disconnected')
      }
    }

    throw createAccountClientError(
      response.status >= 500 ? 'network' : 'authentication-rejected',
      `Thunderbolt CLI device registration failed (${response.status} ${response.statusText})`,
    )
  }

  try {
    return await ensure(credential, false, durableAuth)
  } finally {
    signal?.removeEventListener('abort', retainDeadline)
  }
}

/** Binds web login and remote-first logout to one account/storage configuration. */
export const createAccountActions = (dependencies: AccountActionDependencies): AccountActions => {
  const request = dependencies.fetchFn ?? (fetch as AccountFetch)
  return {
    login: (presentation, signal) => {
      const backendUrl = apiBaseUrl(dependencies.backendUrl)
      return performLogin({
        patToken: dependencies.patToken,
        transport: createHttpTransport(authBaseUrl(backendUrl), request),
        clock: systemClock,
        presentation,
        ensureRegistered: async (bearer) => {
          const deadline = AbortSignal.timeout(defaultRegistrationTimeoutMs)
          const registrationSignal = signal === undefined ? deadline : AbortSignal.any([signal, deadline])
          registrationSignal.throwIfAborted()
          const existingAuth = await abortable(loadAuthConfig(), registrationSignal)
          return ensureRegisteredSession(
            createSessionCredential(backendUrl, bearer, existingAuth),
            dependencies.metadata,
            request,
            registrationSignal,
            existingAuth,
          )
        },
        createQrBlock: createTerminalQrBlock,
        signal,
      })
    },
    logout: async (presentation, signal) =>
      performLogout({
        auth: await loadAuthConfig(),
        patToken: dependencies.patToken,
        fetchFn: dependencies.fetchFn,
        loadAuth: loadAuthConfig,
        compareAndSetAuth: compareAndSetAuthConfig,
        presentation,
        signal,
      }),
  }
}
