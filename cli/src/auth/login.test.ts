/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import type { CliAuth, DeviceGrantPresentation, SessionCredential } from '../provider-runtime/types.ts'
import type { DeviceCodeResponse } from './device-grant.ts'
import { performLogin, type LoginDeps } from './login.ts'


const code: DeviceCodeResponse = {
  deviceCode: 'dev-code',
  userCode: 'WDJB-MJHT',
  verificationUri: 'https://app.test/device',
  verificationUriComplete: 'https://app.test/device?user_code=WDJB-MJHT',
  intervalSeconds: 0,
  expiresInSeconds: 300,
}

const retainedAuth = (): CliAuth => ({
  version: 2,
  backendUrl: 'https://api.test/v1',
  deviceId: 'cli-00000000-0000-4000-8000-000000000001',
  userCacheSecret: 'ab'.repeat(32),
  registration: 'authentication-required',
  bearer: null,
})

/** Records every presentation callback for ordering and payload assertions. */
const createPresentation = (events: string[] = []) => {
  const verifications: Parameters<DeviceGrantPresentation['showVerification']>[0][] = []
  const statuses: { readonly status: 'waiting' | 'success' | 'error'; readonly message?: string }[] = []
  const presentation: DeviceGrantPresentation = {
    showVerification: (value) => {
      events.push('verification')
      verifications.push(value)
    },
    showStatus: (status, message) => {
      events.push(status)
      if (message === undefined) {
        statuses.push({ status })
        return
      }
      statuses.push({ status, message })
    },
  }
  return { presentation, statuses, verifications }
}

/** Builds a fully injected successful web-login flow. */
const createLoginDeps = (overrides: Partial<LoginDeps> = {}) => {
  const events: string[] = []
  const { presentation, statuses, verifications } = createPresentation(events)
  const registered: SessionCredential[] = []
  const deps: LoginDeps = {
    patToken: 'pat-from-environment',
    transport: {
      requestCode: async () => code,
      pollToken: async () => ({ kind: 'approved', token: 'signed.jwt' }),
    },
    clock: { now: () => 0, sleep: async () => {} },
    presentation,
    ensureRegistered: async (bearer) => {
      events.push('registration')
      const stored = retainedAuth()
      const credential: SessionCredential = {
        type: 'session',
        backendUrl: stored.backendUrl,
        bearer,
        deviceId: stored.deviceId,
        userCacheSecret: Uint8Array.from(Buffer.from(stored.userCacheSecret, 'hex')),
      }
      registered.push(credential)
      return credential
    },
    createQrBlock: () => 'qr-block',
    ...overrides,
  }
  return { deps, events, presentation, registered, statuses, verifications }
}

describe('performLogin', () => {
  it('presents the exact verification data and succeeds only after registration', async () => {
    const { deps, events, registered, statuses, verifications } = createLoginDeps()

    const auth = await performLogin(deps)

    expect(verifications).toEqual([
      {
        verificationUrl: code.verificationUri,
        userCode: code.userCode,
        qrBlock: 'qr-block',
      },
    ])
    expect(events).toEqual(['verification', 'waiting', 'registration', 'success'])
    expect(statuses.map(({ status }) => status)).toEqual(['waiting', 'success'])
    expect(statuses.at(-1)?.message).toContain('THUNDERBOLT_TOKEN')
    expect(registered).toHaveLength(1)
    expect(registered[0]).toMatchObject({
      backendUrl: 'https://api.test/v1',
      bearer: 'signed.jwt',
      deviceId: retainedAuth().deviceId,
    })
    expect(Buffer.from(registered[0]!.userCacheSecret).toString('hex')).toBe(retainedAuth().userCacheSecret)
    expect(auth).toEqual({
      ...retainedAuth(),
      registration: 'registered',
      bearer: 'signed.jwt',
    })
  })

  it('omits the optional QR block when the presenter cannot render one', async () => {
    const { deps, verifications } = createLoginDeps({ createQrBlock: () => undefined })

    await performLogin(deps)

    expect(verifications).toEqual([{ verificationUrl: code.verificationUri, userCode: code.userCode }])
  })

  it('offers the exact complete verification URL after the fallback and before polling', async () => {
    const { deps, events, presentation } = createLoginDeps()
    const promptedUrls: string[] = []

    await performLogin({
      ...deps,
      presentation: {
        ...presentation,
        promptToOpenBrowser: async (url) => {
          events.push('browser-prompt')
          promptedUrls.push(url)
        },
      },
      transport: {
        requestCode: deps.transport.requestCode,
        pollToken: async () => {
          events.push('poll')
          return { kind: 'approved', token: 'signed.jwt' }
        },
      },
    })

    expect(promptedUrls).toEqual(['https://app.test/device?user_code=WDJB-MJHT'])
    expect(events.slice(0, 4)).toEqual(['verification', 'browser-prompt', 'waiting', 'poll'])
  })

  it('reports registration failure without ever presenting success', async () => {
    const { deps, events, statuses } = createLoginDeps({
      ensureRegistered: async () => {
        throw new Error('registration failed')
      },
    })

    await expect(performLogin(deps)).rejects.toThrow('registration failed')

    expect(events).toEqual(['verification', 'waiting', 'error'])
    expect(statuses.map(({ status }) => status)).toEqual(['waiting', 'error'])
  })

  it('stops a cancelled device login before registration or success presentation', async () => {
    const controller = new AbortController()
    const polling = Promise.withResolvers<void>()
    const { deps, events, registered, statuses } = createLoginDeps({
      signal: controller.signal,
      transport: {
        requestCode: async () => code,
        pollToken: async () => {
          polling.resolve()
          return { kind: 'pending' }
        },
      },
      clock: {
        now: () => 0,
        sleep: (_ms, signal) => {
          if (signal?.aborted) return Promise.reject(signal.reason)
          return new Promise<void>((_resolve, reject) => {
            signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
          })
        },
      },
    })
    const pending = performLogin(deps)
    await polling.promise

    controller.abort()

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(events).toEqual(['verification', 'waiting'])
    expect(statuses.map(({ status }) => status)).toEqual(['waiting'])
    expect(registered).toEqual([])
  })

})
