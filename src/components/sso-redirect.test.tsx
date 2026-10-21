/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { AuthContext } from '@/contexts/auth-context'
import { useLocalSettingsStore } from '@/stores/local-settings-store'
import { createMockAuthClient } from '@/test-utils/auth-client'
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test'
import * as tauriCore from '@tauri-apps/api/core'
import * as tauriEvent from '@tauri-apps/api/event'
import * as opener from '@tauri-apps/plugin-opener'
import SsoRedirect from './sso-redirect'

const originalCloudUrl = useLocalSettingsStore.getState().cloudUrl
const originalFetch = globalThis.fetch

describe('SsoRedirect', () => {
  afterEach(() => {
    cleanup()
    globalThis.fetch = originalFetch
    useLocalSettingsStore.setState({ cloudUrl: originalCloudUrl })
  })

  it('posts to the exact SSO endpoint when cloudUrl has trailing slashes', async () => {
    const requests: Request[] = []
    globalThis.fetch = Object.assign(
      async (request: RequestInfo | URL) => {
        requests.push(new Request(request))
        return Response.json({ url: 'unsafe redirect fixture' })
      },
      { preconnect: originalFetch.preconnect },
    )
    useLocalSettingsStore.setState({ cloudUrl: 'https://api.example.test/v1///' })
    const authClient = createMockAuthClient()

    render(
      <AuthContext.Provider value={{ authClient }}>
        <SsoRedirect />
      </AuthContext.Provider>,
    )

    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(requests).toHaveLength(1)
    expect(requests[0]?.url).toBe('https://api.example.test/v1/api/auth/sign-in/sso')
    expect(requests[0]?.url).not.toContain('/v1//')

    act(() => useLocalSettingsStore.getState().setLocalSetting('cloudUrl', 'https://api.example.test/v1/'))
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(requests).toHaveLength(1)
  })

  it('asks Better Auth to send a failed login back to the app error page', async () => {
    const bodies: unknown[] = []
    globalThis.fetch = Object.assign(
      async (request: RequestInfo | URL) => {
        bodies.push(await new Request(request).json())
        return Response.json({ url: 'unsafe redirect fixture' })
      },
      { preconnect: originalFetch.preconnect },
    )
    useLocalSettingsStore.setState({ cloudUrl: 'https://api.example.test/v1' })

    render(
      <AuthContext.Provider value={{ authClient: createMockAuthClient() }}>
        <SsoRedirect />
      </AuthContext.Provider>,
    )
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(bodies).toEqual([
      {
        providerId: 'sso',
        callbackURL: `${window.location.origin}/`,
        errorCallbackURL: `${window.location.origin}/sso-error`,
      },
    ])
  })

  describe('on Tauri desktop', () => {
    const renderWithLoopbackCallback = async (callbackUrl: string) => {
      Object.assign(window, { isTauri: true })
      spyOn(tauriCore, 'isTauri').mockReturnValue(true)
      spyOn(tauriCore, 'invoke').mockImplementation(async () => 17421 as never)
      spyOn(opener, 'openUrl').mockImplementation(async () => {})
      spyOn(tauriEvent, 'listen').mockImplementation(async (_event, cb) => {
        queueMicrotask(() => cb({ payload: { url: callbackUrl } } as never))
        return () => {}
      })
      const replaceSpy = spyOn(window.location, 'replace').mockImplementation(() => undefined)
      useLocalSettingsStore.setState({ cloudUrl: 'https://api.example.test/v1' })

      const view = render(
        <AuthContext.Provider value={{ authClient: createMockAuthClient() }}>
          <SsoRedirect />
        </AuthContext.Provider>,
      )
      await act(async () => {
        for (let i = 0; i < 10; i++) {
          await Promise.resolve()
        }
      })
      return { replaceSpy, view }
    }

    afterEach(() => {
      Reflect.deleteProperty(window, 'isTauri')
      mock.restore()
    })

    it('sends a failed login to the error page with the code from the loopback', async () => {
      const { replaceSpy } = await renderWithLoopbackCallback(
        'http://127.0.0.1:17421/?error=access_denied&error_description=free+text',
      )

      expect(replaceSpy).toHaveBeenCalledWith('/sso-error?error=access_denied')
    })

    it('control: a callback with no token and no error keeps the retry screen', async () => {
      const { replaceSpy, view } = await renderWithLoopbackCallback('http://127.0.0.1:17421/')

      expect(replaceSpy).not.toHaveBeenCalled()
      expect(view.getByText('Try again')).toBeTruthy()
    })
  })
})
