/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { AuthContext, createAuthClientInstance } from '@/contexts/auth-context'
import { useLocalSettingsStore } from '@/stores/local-settings-store'
import { createMockAuthClient } from '@/test-utils/auth-client'
import { pendingPromotionKey } from '@/lib/analytics/use-anonymous-promotion-analytics'
import { getClock } from '@/testing-library'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test'
import * as tauriCore from '@tauri-apps/api/core'
import * as tauriEvent from '@tauri-apps/api/event'
import * as opener from '@tauri-apps/plugin-opener'
import * as tauriOs from '@tauri-apps/plugin-os'
import * as authToken from '@/lib/auth-token'
import * as loopback from '@/lib/sso-loopback'
import SsoRedirect from './sso-redirect'

const originalCloudUrl = useLocalSettingsStore.getState().cloudUrl
const originalFetch = globalThis.fetch

describe('SsoRedirect', () => {
  afterEach(() => {
    cleanup()
    globalThis.fetch = originalFetch
    useLocalSettingsStore.setState({ cloudUrl: originalCloudUrl })
    sessionStorage.removeItem(pendingPromotionKey)
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
    const getSession = mock(async () => ({ data: null, error: null }))
    const authClient = createMockAuthClient({ getSession })

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
    expect(getSession).not.toHaveBeenCalled()

    act(() => useLocalSettingsStore.getState().setLocalSetting('cloudUrl', 'https://api.example.test/v1/'))
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(requests).toHaveLength(1)
  })

  it('waits for the session on a direct visit and does not refetch it before redirecting', async () => {
    const requests: Request[] = []
    globalThis.fetch = Object.assign(
      async (request: RequestInfo | URL) => {
        requests.push(new Request(request))
        return Response.json({ url: 'unsafe redirect fixture' })
      },
      { preconnect: originalFetch.preconnect },
    )
    const getSession = mock(async () => ({ data: null, error: null }))
    const renderRedirect = (isPending: boolean) => (
      <AuthContext.Provider value={{ authClient: createMockAuthClient({ isPending, getSession }) }}>
        <SsoRedirect />
      </AuthContext.Provider>
    )
    const view = render(renderRedirect(true))
    await act(async () => {})
    expect(requests).toHaveLength(0)

    view.rerender(renderRedirect(false))
    await act(async () => {})
    expect(requests).toHaveLength(1)
    expect(getSession).not.toHaveBeenCalled()

    // A session observer rerender is not another sign-in attempt.
    view.rerender(renderRedirect(false))
    await act(async () => {})
    expect(requests).toHaveLength(1)

    fireEvent.click(view.getByRole('button', { name: 'Try again' }))
    await act(async () => {})
    expect(requests).toHaveLength(2)
    expect(getSession).not.toHaveBeenCalled()
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

  it('keeps the web attempt and its error stable across signed-out background session refetches', async () => {
    const firstSignIn = Promise.withResolvers<Response>()
    const backgroundSession = Promise.withResolvers<Response>()
    const errorSession = Promise.withResolvers<Response>()
    const sessionRequests: Request[] = []
    const signInRequests: Request[] = []
    globalThis.fetch = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init)
        if (request.url.endsWith('/get-session')) {
          sessionRequests.push(request)
          if (sessionRequests.length === 2) {
            return backgroundSession.promise
          }
          if (sessionRequests.length === 3) {
            return errorSession.promise
          }
          return Response.json(null)
        }
        signInRequests.push(request)
        return signInRequests.length === 1 ? firstSignIn.promise : Response.json({ url: 'unsafe redirect fixture' })
      },
      { preconnect: originalFetch.preconnect },
    )
    useLocalSettingsStore.setState({ cloudUrl: 'https://api.example.test/v1' })
    const authClient = createAuthClientInstance('https://api.example.test/v1')
    const view = render(
      <AuthContext.Provider value={{ authClient }}>
        <SsoRedirect />
      </AuthContext.Provider>,
    )

    try {
      await act(async () => void (await getClock().tickAsync(1)))
      expect(sessionRequests).toHaveLength(1)
      expect(signInRequests).toHaveLength(1)

      await act(async () => {
        window.dispatchEvent(new Event('offline'))
        window.dispatchEvent(new Event('online'))
        await getClock().tickAsync(1)
      })
      expect(sessionRequests).toHaveLength(2)
      expect(authClient.$store.atoms.session.get().isPending).toBe(true)
      expect(signInRequests[0]?.signal.aborted).toBe(false)

      await act(async () => {
        backgroundSession.resolve(Response.json(null))
        await getClock().tickAsync(1)
      })
      expect(authClient.$store.atoms.session.get().isPending).toBe(false)
      expect(signInRequests).toHaveLength(1)

      await act(async () => {
        firstSignIn.resolve(Response.json({ url: 'unsafe redirect fixture' }))
        await getClock().tickAsync(1)
      })
      expect(view.getByRole('button', { name: 'Try again' })).toBeInTheDocument()

      await act(async () => {
        void authClient.$store.atoms.session.get().refetch()
        await getClock().tickAsync(1)
      })
      expect(sessionRequests).toHaveLength(3)
      expect(authClient.$store.atoms.session.get().isPending).toBe(true)
      expect(view.getByRole('button', { name: 'Try again' })).toBeInTheDocument()
      expect(signInRequests).toHaveLength(1)

      await act(async () => {
        fireEvent.click(view.getByRole('button', { name: 'Try again' }))
        await getClock().tickAsync(1)
      })
      expect(signInRequests).toHaveLength(2)

      await act(async () => {
        errorSession.resolve(Response.json(null))
        await getClock().tickAsync(1)
      })
      expect(authClient.$store.atoms.session.get().isPending).toBe(false)
      expect(signInRequests).toHaveLength(2)
      expect(view.getByRole('button', { name: 'Try again' })).toBeInTheDocument()
    } finally {
      backgroundSession.resolve(Response.json(null))
      errorSession.resolve(Response.json(null))
      firstSignIn.resolve(Response.json({ url: 'unsafe redirect fixture' }))
      view.unmount()
      // Nanostores delays its final unsubscribe; release the real client's
      // global online/broadcast listeners before another test starts.
      await act(async () => void (await getClock().tickAsync(1001)))
    }
  })

  describe('on Tauri desktop', () => {
    const renderWithLoopbackCallback = async (callbackUrl: string | null, authClient = createMockAuthClient()) => {
      Object.assign(window, { isTauri: true })
      spyOn(tauriCore, 'isTauri').mockReturnValue(true)
      spyOn(tauriCore, 'invoke').mockImplementation(async () => 17421 as never)
      let complete!: (url: string | URL) => void
      spyOn(opener, 'openUrl').mockImplementation(async (url) => complete(url))
      spyOn(tauriEvent, 'listen').mockImplementation(async (_event, cb) => {
        complete = (initiate) => {
          if (!callbackUrl) {
            return
          }
          const url = new URL(callbackUrl)
          url.hostname = 'localhost' // The native listener emits a canonical localhost URL.
          url.searchParams.set('client_state', new URL(initiate).searchParams.get('client_state')!)
          cb({ payload: { url: url.href } } as never)
        }
        return () => {}
      })
      const replaceSpy = spyOn(window.location, 'replace').mockImplementation(() => undefined)
      useLocalSettingsStore.setState({ cloudUrl: 'https://api.example.test/v1' })

      const view = render(
        <AuthContext.Provider value={{ authClient }}>
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

    it('discards a callback from a server the component no longer belongs to', async () => {
      Object.assign(window, { isTauri: true })
      spyOn(tauriCore, 'isTauri').mockReturnValue(true)
      const oldFlow = Promise.withResolvers<string | null>()
      const nextFlow = Promise.withResolvers<string | null>()
      const flowSpy = spyOn(loopback, 'startSsoFlowLoopback')
        .mockImplementationOnce(() => oldFlow.promise)
        .mockImplementationOnce(() => nextFlow.promise)
      const storeToken = spyOn(authToken, 'setAuthToken').mockImplementation(() => {})
      const replace = spyOn(window.location, 'replace').mockImplementation(() => undefined)
      useLocalSettingsStore.setState({ cloudUrl: 'https://first.example/v1' })
      const view = render(
        <AuthContext.Provider value={{ authClient: createMockAuthClient() }}>
          <SsoRedirect />
        </AuthContext.Provider>,
      )
      await act(async () => {})
      act(() => useLocalSettingsStore.setState({ cloudUrl: 'https://second.example/v1' }))
      await act(async () => {})
      expect(flowSpy).toHaveBeenCalledTimes(2)
      await act(async () => oldFlow.resolve('first-server-token'))
      expect(storeToken).not.toHaveBeenCalled()
      expect(replace).not.toHaveBeenCalled()
      view.unmount()
      await act(async () => nextFlow.reject(new loopback.SsoCallbackError('access_denied')))
      expect(storeToken).not.toHaveBeenCalled()
      expect(replace).not.toHaveBeenCalled()
    })

    it('sends a failed login to the error page with the code from the loopback', async () => {
      const { replaceSpy } = await renderWithLoopbackCallback(
        'http://localhost:17421/?error=access_denied&error_description=free+text',
      )

      expect(replaceSpy).toHaveBeenCalledWith('/sso-error?error=access_denied')
    })

    it('control: a callback with no token and no error keeps the retry screen', async () => {
      const { replaceSpy, view } = await renderWithLoopbackCallback('http://localhost:17421/?state=missing-token')

      expect(replaceSpy).not.toHaveBeenCalled()
      expect(view.getByText('Try again')).toBeTruthy()
      expect(view.queryByRole('button', { name: 'Continue locally' })).not.toBeInTheDocument()
    })

    it('lets an optional server sign-in timeout return to local work', async () => {
      useLocalSettingsStore.setState({ localMode: true })
      const { replaceSpy, view } = await renderWithLoopbackCallback(null)
      await act(async () => void (await getClock().tickAsync(5 * 60 * 1000)))

      fireEvent.click(view.getByRole('button', { name: 'Continue locally' }))

      expect(replaceSpy).toHaveBeenCalledWith('/')
    })

    it('preserves an anonymous session snapshot through the desktop SSO callback without refetching', async () => {
      const getSession = mock(async () => ({ data: null, error: null }))
      const authClient = createMockAuthClient({
        session: { user: { id: 'anonymous-user', email: '', isAnonymous: true } },
        getSession,
      })
      const { replaceSpy } = await renderWithLoopbackCallback('http://localhost:17421/?token=sso-token', authClient)

      expect(getSession).not.toHaveBeenCalled()
      expect(sessionStorage.getItem(pendingPromotionKey)).toBe('1')
      expect(replaceSpy).toHaveBeenCalledWith('/')
    })

    it('does not open another system browser when a signed-out session refetches during loopback sign-in', async () => {
      const backgroundSession = Promise.withResolvers<Response>()
      const sessionRequests: Request[] = []
      globalThis.fetch = Object.assign(
        async (input: RequestInfo | URL, init?: RequestInit) => {
          sessionRequests.push(new Request(input, init))
          return sessionRequests.length === 1 ? Response.json(null) : backgroundSession.promise
        },
        { preconnect: originalFetch.preconnect },
      )
      Object.assign(window, { isTauri: true })
      spyOn(tauriCore, 'isTauri').mockReturnValue(true)
      spyOn(tauriCore, 'invoke').mockImplementation(async () => 17421 as never)
      const openUrl = spyOn(opener, 'openUrl').mockImplementation(async () => {})
      spyOn(tauriOs, 'platform').mockReturnValue('macos')
      const callbacks: Array<() => void> = []
      spyOn(tauriEvent, 'listen').mockImplementation(async (_event, cb) => {
        callbacks.push(() => {
          const state = new URL(openUrl.mock.calls[0][0]).searchParams.get('client_state')!
          cb({ payload: { url: `http://localhost:17421/?client_state=${state}&token=sso-token` } } as never)
        })
        return () => {}
      })
      const replace = spyOn(window.location, 'replace').mockImplementation(() => undefined)
      useLocalSettingsStore.setState({ cloudUrl: 'https://api.example.test/v1' })
      const authClient = createAuthClientInstance('https://api.example.test/v1')
      const view = render(
        <AuthContext.Provider value={{ authClient }}>
          <SsoRedirect />
        </AuthContext.Provider>,
      )

      try {
        await act(async () => void (await getClock().tickAsync(1)))
        expect(openUrl).toHaveBeenCalledTimes(1)

        await act(async () => {
          window.dispatchEvent(new Event('offline'))
          window.dispatchEvent(new Event('online'))
          await getClock().tickAsync(1)
        })
        expect(sessionRequests).toHaveLength(2)
        expect(authClient.$store.atoms.session.get().isPending).toBe(true)
        await act(async () => {
          backgroundSession.resolve(Response.json(null))
          await getClock().tickAsync(1)
        })
        expect(openUrl).toHaveBeenCalledTimes(1)

        await act(async () => {
          callbacks.forEach((callback) => callback())
          await getClock().tickAsync(1)
        })
        expect(replace).toHaveBeenCalledTimes(1)
        expect(replace).toHaveBeenCalledWith('/')
      } finally {
        backgroundSession.resolve(Response.json(null))
        callbacks.forEach((callback) => callback())
        view.unmount()
        await act(async () => void (await getClock().tickAsync(1001)))
      }
    })
  })
})
