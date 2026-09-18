/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cliVersion } from '../version.ts'
import type { AccountFetch, CliAuth, DeviceGrantPresentation, SessionCredential } from '../provider-runtime/types.ts'
import { authConfigPath } from '../paths.ts'
import { loadAuthConfig, resolveAccountCredential, storeAuthConfig } from './token-store.ts'
import { createAccountActions, ensureRegisteredSession, type CliDeviceMetadata } from './account-client.ts'

const metadata: CliDeviceMetadata = { deviceName: 'Workstation' }
const credential = (): SessionCredential => ({
  type: 'session',
  backendUrl: 'https://api.test/v1',
  bearer: 'signed.jwt',
  deviceId: 'cli-00000000-0000-4000-8000-000000000001',
  userCacheSecret: Uint8Array.from({ length: 32 }, (_, index) => index),
})

let home: string
const previousHome = process.env.THUNDERBOLT_HOME

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'tb-account-client-'))
  process.env.THUNDERBOLT_HOME = home
})

afterEach(async () => {
  if (previousHome === undefined) delete process.env.THUNDERBOLT_HOME
  else process.env.THUNDERBOLT_HOME = previousHome
  await rm(home, { recursive: true, force: true })
})

/** Returns a fetch fake that records requests and dispenses scripted responses. */
const scriptedFetch = (responses: readonly (() => Response)[]) => {
  const requests: { readonly input: Parameters<AccountFetch>[0]; readonly init?: RequestInit }[] = []
  const fetchFn: AccountFetch = async (input, init) => {
    requests.push({ input, init })
    const response = responses[requests.length - 1]
    if (!response) throw new Error('unexpected account request')
    return response()
  }
  return { fetchFn, requests }
}

const registeredResponse = (deviceId = credential().deviceId): Response =>
  Response.json({ deviceId, state: 'registered' })

describe('ensureRegisteredSession', () => {
  it('sends the exact bodyless registration request and persists registered state', async () => {
    const session = credential()
    const { fetchFn, requests } = scriptedFetch([() => registeredResponse()])

    const result = await ensureRegisteredSession(session, metadata, fetchFn)

    expect(result).toEqual(session)
    expect(requests).toHaveLength(1)
    expect(String(requests[0]?.input)).toBe('https://api.test/v1/account/devices/cli')
    expect(requests[0]?.init?.method).toBe('PUT')
    expect(requests[0]?.init?.body).toBeUndefined()
    expect(requests[0]?.init?.redirect).toBe('error')
    expect(Object.fromEntries(new Headers(requests[0]?.init?.headers).entries())).toEqual({
      authorization: 'Bearer signed.jwt',
      'x-app-version': cliVersion,
      'x-device-id': 'cli-00000000-0000-4000-8000-000000000001',
      'x-device-name': 'Workstation',
    })
    expect(await loadAuthConfig()).toEqual({
      version: 2,
      backendUrl: session.backendUrl,
      deviceId: session.deviceId,
      userCacheSecret: Buffer.from(session.userCacheSecret).toString('hex'),
      registration: 'registered',
      bearer: session.bearer,
    })
  })

  it('registers a migrated legacy session on its first managed use', async () => {
    await writeFile(authConfigPath(), JSON.stringify({ token: 'legacy.jwt', cloudUrl: 'https://legacy.test/v1' }))
    const migrated = await resolveAccountCredential({ THUNDERBOLT_HOME: home })
    if (migrated?.type !== 'session') throw new Error('expected migrated session')
    const { fetchFn, requests } = scriptedFetch([() => registeredResponse(migrated.deviceId)])

    const registered = await ensureRegisteredSession(migrated, metadata, fetchFn)

    expect(registered.deviceId).toBe(migrated.deviceId)
    expect(requests).toHaveLength(1)
    expect(await loadAuthConfig()).toMatchObject({
      deviceId: migrated.deviceId,
      registration: 'registered',
      bearer: 'legacy.jwt',
    })
  })

  it('idempotently touches an already registered session on every managed startup', async () => {
    const session = credential()
    await storeAuthConfig({
      version: 2,
      backendUrl: session.backendUrl,
      deviceId: session.deviceId,
      userCacheSecret: Buffer.from(session.userCacheSecret).toString('hex'),
      registration: 'registered',
      bearer: session.bearer,
    })
    const { fetchFn, requests } = scriptedFetch([() => registeredResponse(), () => registeredResponse()])

    await ensureRegisteredSession(session, metadata, fetchFn)
    await ensureRegisteredSession(session, metadata, fetchFn)

    expect(requests).toHaveLength(2)
    expect(new Headers(requests[0]?.init?.headers).get('x-device-id')).toBe(session.deviceId)
    expect(new Headers(requests[1]?.init?.headers).get('x-device-id')).toBe(session.deviceId)
  })

  it('retains an existing registered credential when a touch response is lost', async () => {
    const session = credential()
    const registered: CliAuth = {
      version: 2,
      backendUrl: session.backendUrl,
      deviceId: session.deviceId,
      userCacheSecret: Buffer.from(session.userCacheSecret).toString('hex'),
      registration: 'registered',
      bearer: session.bearer,
    }
    await storeAuthConfig(registered)
    const fetchFn: AccountFetch = async () => {
      throw new Error('connection reset after server commit')
    }

    await expect(ensureRegisteredSession(session, metadata, fetchFn)).rejects.toMatchObject({
      code: 'network',
    })
    expect(await loadAuthConfig()).toEqual(registered)
  })

  it.each([
    ['caller cancellation', (controller: AbortController) => controller.abort(), 'AbortError'],
    [
      'caller deadline',
      (controller: AbortController) =>
        controller.abort(new DOMException('The operation timed out.', 'TimeoutError')),
      'TimeoutError',
    ],
  ] as const)(
    'settles a never-resolving registration on %s while retaining installation metadata',
    async (_name, abort, errorName) => {
      const controller = new AbortController()
      const requestStarted = Promise.withResolvers<void>()
      const fetchFn: AccountFetch = async () => {
        requestStarted.resolve()
        return new Promise<Response>(() => {})
      }
      const pending = ensureRegisteredSession(credential(), metadata, fetchFn, controller.signal)
      await requestStarted.promise
      abort(controller)

      await expect(pending).rejects.toMatchObject({ name: errorName })
      expect(await loadAuthConfig()).toMatchObject({
        deviceId: credential().deviceId,
        userCacheSecret: Buffer.from(credential().userCacheSecret).toString('hex'),
        registration: 'authentication-required',
        bearer: null,
      })
    },
  )

  it('clears only the rejected bearer on a definitive 401', async () => {
    const session = credential()
    await storeAuthConfig({
      version: 2,
      backendUrl: session.backendUrl,
      deviceId: session.deviceId,
      userCacheSecret: Buffer.from(session.userCacheSecret).toString('hex'),
      registration: 'registered',
      bearer: session.bearer,
    })
    const { fetchFn } = scriptedFetch([() => Response.json({ error: 'Unauthorized' }, { status: 401 })])

    await expect(ensureRegisteredSession(session, metadata, fetchFn)).rejects.toMatchObject({
      code: 'authentication-required',
    })
    expect(await loadAuthConfig()).toEqual({
      version: 2,
      backendUrl: session.backendUrl,
      deviceId: session.deviceId,
      userCacheSecret: Buffer.from(session.userCacheSecret).toString('hex'),
      registration: 'authentication-required',
      bearer: null,
    })
  })

  it('rotates a revoked device ID and cache secret once before registering', async () => {
    const session = credential()
    const { fetchFn, requests } = scriptedFetch([
      () => Response.json({ code: 'DEVICE_DISCONNECTED' }, { status: 403 }),
      () => {
        const rotatedId = new Headers(requests[1]?.init?.headers).get('x-device-id')
        return Response.json({ deviceId: rotatedId, state: 'registered' })
      },
    ])

    const rotated = await ensureRegisteredSession(session, metadata, fetchFn)

    expect(requests).toHaveLength(2)
    expect(rotated.deviceId).toMatch(/^cli-[0-9a-f-]{36}$/)
    expect(rotated.deviceId).not.toBe(session.deviceId)
    expect(rotated.userCacheSecret).toHaveLength(32)
    expect(rotated.userCacheSecret).not.toEqual(session.userCacheSecret)
    expect(new Headers(requests[1]?.init?.headers).get('x-device-id')).toBe(rotated.deviceId)
    expect(await loadAuthConfig()).toMatchObject({
      deviceId: rotated.deviceId,
      userCacheSecret: Buffer.from(rotated.userCacheSecret).toString('hex'),
      registration: 'registered',
      bearer: session.bearer,
    })
  })

  it('rotates the installation once when switching accounts on the same backend', async () => {
    const previous = credential()
    await storeAuthConfig({
      version: 2,
      backendUrl: previous.backendUrl,
      deviceId: previous.deviceId,
      userCacheSecret: Buffer.from(previous.userCacheSecret).toString('hex'),
      registration: 'registered',
      bearer: 'previous-account-session',
    })
    const session = { ...previous, bearer: 'new-account-session' }
    const { fetchFn, requests } = scriptedFetch([
      () => Response.json({ code: 'DEVICE_ID_TAKEN' }, { status: 409 }),
      () => {
        const rotatedId = new Headers(requests[1]?.init?.headers).get('x-device-id')
        return Response.json({ deviceId: rotatedId, state: 'registered' })
      },
    ])

    const registered = await ensureRegisteredSession(session, metadata, fetchFn)

    expect(requests).toHaveLength(2)
    expect(registered.deviceId).not.toBe(previous.deviceId)
    expect(registered.userCacheSecret).not.toEqual(previous.userCacheSecret)
    expect(await loadAuthConfig()).toMatchObject({
      deviceId: registered.deviceId,
      registration: 'registered',
      bearer: 'new-account-session',
    })
  })

  it('never rotates or retries more than once for repeated tombstone responses', async () => {
    const session = credential()
    const disconnected = () => Response.json({ code: 'DEVICE_DISCONNECTED' }, { status: 403 })
    const { fetchFn, requests } = scriptedFetch([disconnected, disconnected])

    await expect(ensureRegisteredSession(session, metadata, fetchFn)).rejects.toMatchObject({
      code: 'device-disconnected',
    })

    expect(requests).toHaveLength(2)
    expect(new Headers(requests[1]?.init?.headers).get('x-device-id')).not.toBe(session.deviceId)
    expect(await loadAuthConfig()).toMatchObject({
      registration: 'authentication-required',
      bearer: null,
    })
  })

  it('rejects an insecure registration URL before sending or persisting credentials', async () => {
    const session = { ...credential(), backendUrl: 'https://api.example.test/v1?source=cli' }
    const { fetchFn, requests } = scriptedFetch([() => registeredResponse()])

    await expect(ensureRegisteredSession(session, metadata, fetchFn)).rejects.toThrow('insecure')

    expect(requests).toEqual([])
    expect(await loadAuthConfig()).toBeNull()
  })
})

describe('createAccountActions', () => {
  it('runs web login with a PAT, registers, then reports success through the presentation', async () => {
    const existing: CliAuth = {
      version: 2,
      backendUrl: 'https://api.test/v1',
      deviceId: credential().deviceId,
      userCacheSecret: 'ab'.repeat(32),
      registration: 'authentication-required',
      bearer: null,
    }
    await storeAuthConfig(existing)
    const requests: { readonly input: Parameters<AccountFetch>[0]; readonly init?: RequestInit }[] = []
    const events: string[] = []
    const statuses: string[] = []
    const verifications: Parameters<DeviceGrantPresentation['showVerification']>[0][] = []
    const presentation: DeviceGrantPresentation = {
      showVerification: (value) => {
        events.push('verification')
        verifications.push(value)
      },
      showStatus: (status) => {
        events.push(status)
        statuses.push(status)
      },
    }
    const fetchFn: AccountFetch = async (input, init) => {
      requests.push({ input, init })
      if (requests.length === 1) {
        return Response.json({
          device_code: 'device-code',
          user_code: 'ABCD-EFGH',
          verification_uri: 'https://app.test/device',
          verification_uri_complete: 'https://app.test/device?user_code=ABCD-EFGH',
          interval: 0,
          expires_in: 300,
        })
      }
      if (requests.length === 2) {
        return new Response(null, { status: 200, headers: { 'set-auth-token': 'new.signed.jwt' } })
      }
      events.push('registration')
      const deviceId = new Headers(init?.headers).get('x-device-id')
      return Response.json({ deviceId, state: 'registered' })
    }
    const actions = createAccountActions({
      backendUrl: 'https://api.test/v1',
      metadata,
      fetchFn,
      patToken: 'pat-from-environment',
    })

    const result = await actions.login(presentation)

    expect(requests.map(({ input }) => String(input))).toEqual([
      'https://api.test/v1/api/auth/device/code',
      'https://api.test/v1/api/auth/device/token',
      'https://api.test/v1/account/devices/cli',
    ])
    expect(verifications[0]).toMatchObject({
      verificationUrl: 'https://app.test/device',
      userCode: 'ABCD-EFGH',
    })
    expect(statuses).toEqual(['waiting', 'success'])
    expect(result).toEqual({
      ...existing,
      registration: 'registered',
      bearer: 'new.signed.jwt',
    })
    expect(await loadAuthConfig()).toEqual(result)
  })

  it('chooses installation identity from post-approval auth instead of a stale pre-grant snapshot', async () => {
    const authA: CliAuth = {
      version: 2,
      backendUrl: 'https://api.test/v1',
      deviceId: 'cli-00000000-0000-4000-8000-000000000001',
      userCacheSecret: 'aa'.repeat(32),
      registration: 'authentication-required',
      bearer: null,
    }
    const authB: CliAuth = {
      ...authA,
      deviceId: 'cli-00000000-0000-4000-8000-000000000002',
      userCacheSecret: 'bb'.repeat(32),
    }
    await storeAuthConfig(authA)
    let request = 0
    let registeredDeviceId: string | null = null
    const readRegisteredDeviceId = (): string | null => registeredDeviceId
    const actions = createAccountActions({
      backendUrl: 'https://api.test/v1',
      metadata,
      fetchFn: async (_input, init) => {
        request += 1
        if (request === 1) {
          await storeAuthConfig(authB)
          return Response.json({
            device_code: 'device-code',
            user_code: 'ABCD-EFGH',
            verification_uri: 'https://app.test/device',
            verification_uri_complete: 'https://app.test/device?user_code=ABCD-EFGH',
            interval: 0,
            expires_in: 300,
          })
        }
        if (request === 2) {
          return new Response(null, { status: 200, headers: { 'set-auth-token': 'new-session' } })
        }
        registeredDeviceId = new Headers(init?.headers).get('x-device-id')
        return Response.json({ deviceId: registeredDeviceId, state: 'registered' })
      },
    })

    const registered = await actions.login({ showVerification: () => {}, showStatus: () => {} })

    expect(readRegisteredDeviceId()).toBe(authB.deviceId)
    expect(registered).toMatchObject({
      deviceId: authB.deviceId,
      userCacheSecret: authB.userCacheSecret,
      bearer: 'new-session',
    })
  })

  it('does not persist usable auth when bound login registration fails', async () => {
    const responses = [
      () =>
        Response.json({
          device_code: 'device-code',
          user_code: 'ABCD-EFGH',
          verification_uri: 'https://app.test/device',
          verification_uri_complete: 'https://app.test/device?user_code=ABCD-EFGH',
          interval: 0,
          expires_in: 300,
        }),
      () => new Response(null, { status: 200, headers: { 'set-auth-token': 'new.signed.jwt' } }),
      () => Response.json({ error: 'Unavailable' }, { status: 503 }),
    ]
    const fetchFn: AccountFetch = async () => {
      const next = responses.shift()
      if (!next) throw new Error('unexpected request replay')
      return next()
    }
    const presentation: DeviceGrantPresentation = { showVerification: () => {}, showStatus: () => {} }
    const actions = createAccountActions({
      backendUrl: 'https://api.test/v1',
      metadata,
      fetchFn,
    })

    await expect(actions.login(presentation)).rejects.toMatchObject({ code: 'network' })

    const stored = await loadAuthConfig()
    expect(stored).toMatchObject({
      registration: 'authentication-required',
      bearer: null,
      backendUrl: 'https://api.test/v1',
    })
    expect(stored?.deviceId).toMatch(/^cli-[0-9a-f-]{36}$/)
    expect(stored?.userCacheSecret).toMatch(/^[0-9a-f]{64}$/)
  })

  it('reuses a fresh installation identity after the server commits registration but the response is lost', async () => {
    const registrationIds: string[] = []
    const registrationSecrets: string[] = []
    let requestIndex = 0
    const fetchFn: AccountFetch = async (_input, init) => {
      requestIndex += 1
      if (requestIndex === 1 || requestIndex === 4) {
        return Response.json({
          device_code: `device-code-${requestIndex}`,
          user_code: 'ABCD-EFGH',
          verification_uri: 'https://app.test/device',
          verification_uri_complete: 'https://app.test/device?user_code=ABCD-EFGH',
          interval: 0,
          expires_in: 300,
        })
      }
      if (requestIndex === 2 || requestIndex === 5) {
        return new Response(null, { status: 200, headers: { 'set-auth-token': `session-${requestIndex}` } })
      }

      const deviceId = new Headers(init?.headers).get('x-device-id')
      if (deviceId === null) throw new Error('registration request missing device id')
      registrationIds.push(deviceId)
      registrationSecrets.push((await loadAuthConfig())?.userCacheSecret ?? '')
      if (requestIndex === 3) throw new Error('response lost after registration commit')
      return Response.json({ deviceId, state: 'registered' })
    }
    const actions = createAccountActions({
      backendUrl: 'https://api.test/v1',
      metadata,
      fetchFn,
    })
    const presentation: DeviceGrantPresentation = { showVerification: () => {}, showStatus: () => {} }

    await expect(actions.login(presentation)).rejects.toMatchObject({
      code: 'network',
    })
    expect(await loadAuthConfig()).toMatchObject({ registration: 'authentication-required', bearer: null })
    const pending = await loadAuthConfig()
    if (pending === null) throw new Error('registration failure must retain pending installation metadata')

    const registered = await actions.login(presentation)

    expect(registrationIds).toEqual([pending.deviceId, pending.deviceId])
    expect(registrationSecrets).toEqual([pending.userCacheSecret, pending.userCacheSecret])
    expect(registered).toMatchObject({
      deviceId: pending.deviceId,
      userCacheSecret: pending.userCacheSecret,
      registration: 'registered',
      bearer: 'session-5',
    })
  })

  it('bounds post-approval registration without shortening human approval and reuses the pending installation', async () => {
    const registrationStarted = Promise.withResolvers<void>()
    const registrationIds: string[] = []
    const registrationSecrets: string[] = []
    let loginAttempt = 0
    let requestInAttempt = 0
    const fetchFn: AccountFetch = async (_input, init) => {
      requestInAttempt += 1
      if (requestInAttempt === 1) {
        loginAttempt += 1
        return Response.json({
          device_code: `device-code-${loginAttempt}`,
          user_code: 'ABCD-EFGH',
          verification_uri: 'https://app.test/device',
          verification_uri_complete: 'https://app.test/device?user_code=ABCD-EFGH',
          interval: 0,
          expires_in: 300,
        })
      }
      if (requestInAttempt === 2) {
        return new Response(null, { status: 200, headers: { 'set-auth-token': `session-${loginAttempt}` } })
      }

      requestInAttempt = 0
      const deviceId = new Headers(init?.headers).get('x-device-id')
      if (deviceId === null) throw new Error('registration request missing device id')
      registrationIds.push(deviceId)
      registrationSecrets.push((await loadAuthConfig())?.userCacheSecret ?? '')
      if (loginAttempt === 1) {
        registrationStarted.resolve()
        return new Promise<Response>(() => {})
      }
      return Response.json({ deviceId, state: 'registered' })
    }
    const actions = createAccountActions({
      backendUrl: 'https://api.test/v1',
      metadata,
      fetchFn,
    })
    const presentation: DeviceGrantPresentation = { showVerification: () => {}, showStatus: () => {} }
    const registrationDeadline = new AbortController()

    const first = actions.login(presentation, registrationDeadline.signal)
    await registrationStarted.promise
    registrationDeadline.abort(new DOMException('registration deadline', 'TimeoutError'))
    await expect(first).rejects.toMatchObject({ name: 'TimeoutError' })
    const pending = await loadAuthConfig()
    if (pending === null) throw new Error('registration timeout must retain pending installation metadata')
    expect(pending).toMatchObject({ registration: 'authentication-required', bearer: null })

    const registered = await actions.login(presentation)

    expect(registrationIds).toEqual([pending.deviceId, pending.deviceId])
    expect(registrationSecrets).toEqual([pending.userCacheSecret, pending.userCacheSecret])
    expect(registered).toMatchObject({
      deviceId: pending.deviceId,
      userCacheSecret: pending.userCacheSecret,
      registration: 'registered',
      bearer: 'session-2',
    })
  })

  it('retains a fresh pending installation after a malformed successful registration response', async () => {
    const responses = [
      () =>
        Response.json({
          device_code: 'device-code',
          user_code: 'ABCD-EFGH',
          verification_uri: 'https://app.test/device',
          verification_uri_complete: 'https://app.test/device?user_code=ABCD-EFGH',
          interval: 0,
          expires_in: 300,
        }),
      () => new Response(null, { status: 200, headers: { 'set-auth-token': 'new.signed.jwt' } }),
      () => Response.json({ deviceId: 'wrong-device', state: 'registered' }),
    ]
    const actions = createAccountActions({
      backendUrl: 'https://api.test/v1',
      metadata,
      fetchFn: async () => {
        const response = responses.shift()
        if (!response) throw new Error('unexpected request replay')
        return response()
      },
    })

    await expect(actions.login({ showVerification: () => {}, showStatus: () => {} })).rejects.toMatchObject({
      code: 'authentication-rejected',
    })
    expect(await loadAuthConfig()).toMatchObject({ registration: 'authentication-required', bearer: null })
  })

  it('logs out a stored web session even while a PAT remains effective', async () => {
    const existing: CliAuth = {
      version: 2,
      backendUrl: 'https://api.test/v1',
      deviceId: credential().deviceId,
      userCacheSecret: 'ab'.repeat(32),
      registration: 'registered',
      bearer: 'stored.signed.jwt',
    }
    const requests: { readonly input: Parameters<AccountFetch>[0]; readonly init?: RequestInit }[] = []
    await storeAuthConfig(existing)
    const actions = createAccountActions({
      backendUrl: 'https://api.test/v1',
      metadata,
      fetchFn: async (input, init) => {
        requests.push({ input, init })
        return new Response(null, { status: 204 })
      },
      patToken: 'pat-from-environment',
    })

    const result = await actions.logout({ showVerification: () => {}, showStatus: () => {} })

    expect(result).toBe('logged-out')
    expect(requests).toHaveLength(1)
    expect(new Headers(requests[0]?.init?.headers).get('authorization')).toBe('Bearer stored.signed.jwt')
    expect(await loadAuthConfig()).toBeNull()
  })

  it.each([204, 401] as const)(
    'does not let a delayed authoritative %s for session A mutate newer session B',
    async (status) => {
      const authA: CliAuth = {
        version: 2,
        backendUrl: 'https://api.test/v1',
        deviceId: 'cli-00000000-0000-4000-8000-000000000001',
        userCacheSecret: 'aa'.repeat(32),
        registration: 'registered',
        bearer: 'session-a',
      }
      const authB: CliAuth = {
        ...authA,
        deviceId: 'cli-00000000-0000-4000-8000-000000000002',
        userCacheSecret: 'bb'.repeat(32),
        bearer: 'session-b',
      }
      await storeAuthConfig(authA)
      const requestStarted = Promise.withResolvers<void>()
      const releaseResponse = Promise.withResolvers<void>()
      const actions = createAccountActions({
        backendUrl: 'https://api.test/v1',
        metadata,
        fetchFn: async () => {
          requestStarted.resolve()
          await releaseResponse.promise
          return new Response(null, { status })
        },
      })

      const logout = actions.logout({ showVerification: () => {}, showStatus: () => {} })
      await requestStarted.promise
      await storeAuthConfig(authB)
      releaseResponse.resolve()
      await logout

      expect(await loadAuthConfig()).toEqual(authB)
    },
  )
})
