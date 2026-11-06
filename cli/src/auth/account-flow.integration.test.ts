/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAccountActions, ensureRegisteredSession } from './account-client.ts'
import { authConfigPath } from '../paths.ts'
import {
  loadAuthConfig,
  resolveAccountCredential,
} from './token-store.ts'
import type { AccountFetch, DeviceGrantPresentation, SessionCredential } from '../provider-runtime/types.ts'

type AccountRequestSnapshot = {
  readonly url: string
  readonly method: string
  readonly headers: Headers
  readonly body: string | null
}
type ExpectedAccountRequest = {
  readonly url: string
  readonly method: string
  readonly body: string | null
  readonly authorization: string | null
  readonly respond: (request: AccountRequestSnapshot) => Response | Promise<Response>
}

const metadata = { deviceName: 'Acceptance CLI' } as const
const apiBaseUrl = 'https://api.example.test/v1'
const authBaseUrl = `${apiBaseUrl}/api/auth`
const cliDeviceIdPattern = /^cli-[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const previousHome = process.env.THUNDERBOLT_HOME
let isolatedHome = ''

const environment = () => ({
  ...process.env,
  THUNDERBOLT_HOME: isolatedHome,
})
const authPath = (): string => authConfigPath(environment())

beforeEach(async () => {
  isolatedHome = await mkdtemp(join(tmpdir(), 'thunderbolt-account-flow-'))
  process.env.THUNDERBOLT_HOME = isolatedHome
})

afterEach(async () => {
  if (previousHome === undefined) delete process.env.THUNDERBOLT_HOME
  else process.env.THUNDERBOLT_HOME = previousHome
  await rm(isolatedHome, { recursive: true, force: true })
})

/** Describe one exact account request and its fixture response. */
const expectedRequest = (
  path: string,
  respond: ExpectedAccountRequest['respond'],
  options: Omit<ExpectedAccountRequest, 'url' | 'respond'>,
): ExpectedAccountRequest => ({ url: `${apiBaseUrl}${path}`, respond, ...options })

/** Create an ordered account transport that validates the complete wire contract. */
const createStrictFetch = (expectedRequests: readonly ExpectedAccountRequest[]) => {
  const requests: AccountRequestSnapshot[] = []
  const fetchFn: AccountFetch = async (input, init) => {
    const request = {
      url: String(input),
      method: init?.method ?? 'GET',
      headers: new Headers(init?.headers),
      body: init?.body === undefined ? null : await new Response(init.body).text(),
    }
    requests.push(request)
    const expected = expectedRequests[requests.length - 1]
    if (!expected) throw new Error(`unexpected account request ${request.method} ${request.url}`)
    expect({
      url: request.url,
      method: request.method,
      body: request.body,
      authorization: request.headers.get('authorization'),
    }).toEqual({
      url: expected.url,
      method: expected.method,
      body: expected.body,
      authorization: expected.authorization,
    })
    return expected.respond(request)
  }
  /** Assert every declared request contract was consumed exactly once. */
  const assertComplete = (): void => {
    expect(requests).toHaveLength(expectedRequests.length)
  }
  return { assertComplete, fetchFn, requests }
}

/** Return the exact registration acknowledgement for the request's installation ID. */
const registeredResponse = (request: AccountRequestSnapshot): Response =>
  Response.json({ deviceId: request.headers.get('x-device-id'), state: 'registered' })

/** Return a complete one-poll device-grant code response. */
const deviceCodeResponse = (): Response =>
  Response.json({
    device_code: 'acceptance-device-code',
    user_code: 'ABCD-EFGH',
    verification_uri: 'https://app.example.test/device',
    verification_uri_complete: 'https://app.example.test/device?user_code=ABCD-EFGH',
    interval: 0,
    expires_in: 300,
  })

/** Return an approved device-grant response carrying the signed session bearer. */
const deviceTokenResponse = (bearer: string): Response =>
  new Response(null, { status: 200, headers: { 'set-auth-token': bearer } })

/** Describe one complete device login ending in an exact registered bearer. */
const expectedLoginRequests = (bearer: string): readonly ExpectedAccountRequest[] => [
  {
    url: `${authBaseUrl}/device/code`,
    method: 'POST',
    body: JSON.stringify({ client_id: 'thunderbolt-cli' }),
    authorization: null,
    respond: deviceCodeResponse,
  },
  {
    url: `${authBaseUrl}/device/token`,
    method: 'POST',
    body: JSON.stringify({
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      device_code: 'acceptance-device-code',
      client_id: 'thunderbolt-cli',
    }),
    authorization: null,
    respond: () => deviceTokenResponse(bearer),
  },
  expectedRequest('/account/devices/cli', registeredResponse, {
    method: 'PUT',
    body: null,
    authorization: `Bearer ${bearer}`,
  }),
]

/** Record lifecycle presentation without coupling acceptance behavior to terminal output. */
const createPresentation = () => {
  const statuses: Array<'waiting' | 'success' | 'error'> = []
  const presentation: DeviceGrantPresentation = {
    showVerification: () => {},
    showStatus: (status) => {
      statuses.push(status)
    },
  }
  return { presentation, statuses }
}

/** Bind production account actions to the real isolated auth store. */
const createStoredActions = (fetchFn: AccountFetch) =>
  createAccountActions({
    backendUrl: 'https://api.example.test/v1',
    metadata,
    fetchFn,
  })

describe('CLI account installation acceptance', () => {
  it('migrates and touches legacy auth, retains installation on 401, relinks it, then uses a new ID after logout', async () => {
    await writeFile(
      authPath(),
      JSON.stringify({ token: 'legacy.signed.bearer', cloudUrl: 'https://api.example.test/v1' }),
    )
    const migrated = await resolveAccountCredential(environment())
    if (migrated?.type !== 'session') throw new Error('expected a migrated legacy session')
    const migratedSecret = Buffer.from(migrated.userCacheSecret).toString('hex')

    const registration = createStrictFetch([
      expectedRequest('/account/devices/cli', registeredResponse, {
        method: 'PUT',
        body: null,
        authorization: 'Bearer legacy.signed.bearer',
      }),
      expectedRequest('/account/devices/cli', registeredResponse, {
        method: 'PUT',
        body: null,
        authorization: 'Bearer legacy.signed.bearer',
      }),
      expectedRequest('/account/devices/cli', () => Response.json({ error: 'Unauthorized' }, { status: 401 }), {
        method: 'PUT',
        body: null,
        authorization: 'Bearer legacy.signed.bearer',
      }),
    ])
    await ensureRegisteredSession(migrated, metadata, registration.fetchFn)
    await ensureRegisteredSession(migrated, metadata, registration.fetchFn)
    await expect(ensureRegisteredSession(migrated, metadata, registration.fetchFn)).rejects.toMatchObject({
      code: 'authentication-required',
    })

    registration.assertComplete()
    expect(registration.requests.map((request) => request.headers.get('x-device-id'))).toEqual([
      migrated.deviceId,
      migrated.deviceId,
      migrated.deviceId,
    ])
    const rejected = await loadAuthConfig(authPath())
    expect(rejected).toEqual({
      version: 2,
      backendUrl: migrated.backendUrl,
      deviceId: migrated.deviceId,
      userCacheSecret: migratedSecret,
      registration: 'authentication-required',
      bearer: null,
    })

    const relinkTransport = createStrictFetch(expectedLoginRequests('relinked.signed.bearer'))
    const relinkPresentation = createPresentation()
    const relinked = await createStoredActions(relinkTransport.fetchFn).login(relinkPresentation.presentation)

    expect(relinked.deviceId).toBe(migrated.deviceId)
    expect(relinked.userCacheSecret).toBe(migratedSecret)
    expect(relinked).toMatchObject({ registration: 'registered', bearer: 'relinked.signed.bearer' })
    expect(relinkPresentation.statuses).toEqual(['waiting', 'success'])
    relinkTransport.assertComplete()

    const logoutTransport = createStrictFetch([
      expectedRequest('/account/devices/cli/logout', () => new Response(null, { status: 204 }), {
        method: 'POST',
        body: null,
        authorization: 'Bearer relinked.signed.bearer',
      }),
    ])
    const logoutPresentation = createPresentation()
    const logout = await createStoredActions(logoutTransport.fetchFn).logout(logoutPresentation.presentation)

    expect(logout).toBe('logged-out')
    logoutTransport.assertComplete()
    expect(await loadAuthConfig(authPath())).toBeNull()
    expect(logoutPresentation.statuses).toEqual(['waiting', 'success'])

    const freshLoginTransport = createStrictFetch(expectedLoginRequests('fresh.signed.bearer'))
    const fresh = await createStoredActions(freshLoginTransport.fetchFn).login(createPresentation().presentation)

    freshLoginTransport.assertComplete()
    expect(fresh.deviceId).not.toBe(migrated.deviceId)
    expect(fresh.userCacheSecret).not.toBe(migratedSecret)
    expect(fresh).toMatchObject({ registration: 'registered', bearer: 'fresh.signed.bearer' })
  })

  it('rotates a revoked tombstone exactly once and retains only the rotated installation', async () => {
    const originalSecretHex = '20'.repeat(32)
    const original: SessionCredential = {
      type: 'session',
      backendUrl: 'https://api.example.test/v1',
      bearer: 'revoked.signed.bearer',
      deviceId: `cli-${crypto.randomUUID()}`,
      userCacheSecret: new Uint8Array(32).fill(0x20),
    }
    const disconnected = () => Response.json({ code: 'DEVICE_DISCONNECTED' }, { status: 403 })
    const transport = createStrictFetch([
      expectedRequest('/account/devices/cli', disconnected, {
        method: 'PUT',
        body: null,
        authorization: 'Bearer revoked.signed.bearer',
      }),
      expectedRequest('/account/devices/cli', disconnected, {
        method: 'PUT',
        body: null,
        authorization: 'Bearer revoked.signed.bearer',
      }),
    ])

    await expect(ensureRegisteredSession(original, metadata, transport.fetchFn)).rejects.toMatchObject({
      code: 'device-disconnected',
    })

    transport.assertComplete()
    const attemptedIds = transport.requests.map((request) => request.headers.get('x-device-id'))
    expect(original.deviceId).toMatch(cliDeviceIdPattern)
    expect(attemptedIds[0]).toBe(original.deviceId)
    expect(attemptedIds[1]).toMatch(cliDeviceIdPattern)
    expect(attemptedIds[1]).not.toBe(original.deviceId)
    const persisted = await loadAuthConfig(authPath())
    expect(persisted?.userCacheSecret).not.toBe(originalSecretHex)
    expect(persisted).toMatchObject({
      version: 2,
      backendUrl: original.backendUrl,
      deviceId: attemptedIds[1],
      userCacheSecret: expect.stringMatching(/^[0-9a-f]{64}$/),
      registration: 'authentication-required',
      bearer: null,
    })
  })
})
