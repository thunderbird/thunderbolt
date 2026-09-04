/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * The registry fetch, in every state a caller has to render.
 *
 * The property under test throughout is that `loading` always ends. Callers
 * treat it as "wait, don't judge yet" — `MiniAppPage` renders nothing at all
 * while it holds — so a path that never leaves it is a permanently blank screen
 * rather than an error anyone can act on.
 *
 * The distinction between `failed` and an empty `apps` matters just as much: an
 * empty registry means this deployment runs no apps, while a failed one means we
 * don't know, and the difference decides whether the chat banner accuses a
 * healthy app of being gone.
 */

import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'bun:test'
import type { ReactNode } from 'react'

import { HttpClientProvider } from '@/contexts/http-client-context'
import { createAuthenticatedClient, type HttpClient } from '@/lib/http'
import { getClock } from '@/testing-library'
import { resetMiniAppsForTesting, useMiniApps } from './use-mini-apps'

const app = {
  id: 'finance-model',
  name: 'Finance Model',
  description: 'Quarterly revenue.',
  icon: 'line-chart',
  url: 'http://localhost:5174',
  origin: 'http://localhost:5174',
}

/**
 * The real client with its fetch injected, so response handling is exercised
 * rather than stubbed away — same shape as `mini-app-auth.test.ts`.
 *
 * The injected fetch honours `signal`, because that is how `HttpClient`
 * implements `timeout`: it composes an abort signal and hands it to the request,
 * so a fake that ignored abort could never time out and the deadline would look
 * broken in a test while working in the browser.
 */
const clientWith = (handler: (request: Request) => Response | Promise<Response>): HttpClient =>
  createAuthenticatedClient('http://localhost:8000', () => 'session-token', {
    fetch: ((input: Request) =>
      new Promise<Response>((resolve, reject) => {
        if (input.signal.aborted) {
          reject(input.signal.reason)
          return
        }
        input.signal.addEventListener('abort', () => reject(input.signal.reason))
        void Promise.resolve(handler(input)).then(resolve, reject)
      })) as typeof fetch,
  })

/**
 * Let the mount effect's fetch settle.
 *
 * `waitFor` is not usable here: the suite installs fake timers for every test,
 * and testing-library's polling drives them through a `jest` shim that Bun's own
 * `jest` object shadows. Advancing the shared clock is the house pattern and is
 * deterministic besides.
 */
const settle = async () => {
  await act(async () => {
    await getClock().tickAsync(1)
  })
}

const setup = (httpClient: HttpClient) => {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <HttpClientProvider httpClient={httpClient}>{children}</HttpClientProvider>
  )
  return renderHook(() => useMiniApps(), { wrapper })
}

afterEach(resetMiniAppsForTesting)

describe('useMiniApps', () => {
  it('starts loading, with nothing to show yet', () => {
    const { result } = setup(clientWith(() => Response.json({ apps: [] })))

    expect(result.current).toMatchObject({ loading: true, failed: false, apps: [] })
  })

  it('publishes the registry once it lands', async () => {
    const { result } = setup(clientWith(() => Response.json({ apps: [app] })))

    await settle()

    expect(result.current).toMatchObject({ loading: false, failed: false })
    expect(result.current.apps.map((entry) => entry.id)).toEqual(['finance-model'])
  })

  /** A deployment that runs no apps is a healthy answer, not a failure. */
  it('separates an empty registry from a broken one', async () => {
    const { result } = setup(clientWith(() => Response.json({ apps: [] })))

    await settle()

    expect(result.current).toMatchObject({ loading: false, failed: false, apps: [] })
  })

  it('reports a failure when the request errors', async () => {
    const { result } = setup(clientWith(() => new Response('nope', { status: 500 })))

    await settle()

    expect(result.current).toMatchObject({ loading: false, failed: true })
  })

  /** A body we can't read is the `failed` case: reporting it as an empty
   *  registry would erase the only distinction callers have. */
  it('reports a failure when the body is not a registry', async () => {
    const { result } = setup(clientWith(() => Response.json({ nope: true })))

    await settle()

    expect(result.current).toMatchObject({ loading: false, failed: true })
  })

  /**
   * The reason there is a deadline at all. A server that accepts the connection
   * and never answers used to leave this on `loading` for the life of the tab,
   * which `MiniAppPage` renders as a blank screen with nothing logged.
   */
  it('gives up rather than loading forever when the server never answers', async () => {
    const { result } = setup(clientWith(() => new Promise<Response>(() => {})))

    await settle()
    expect(result.current.loading).toBe(true)

    await act(async () => {
      await getClock().tickAsync(10_000)
    })

    expect(result.current).toMatchObject({ loading: false, failed: true })
  })

  /** The sidebar and the route both mount this; one answer, one request. */
  it('shares one request between callers', async () => {
    let requests = 0
    const client = clientWith(() => {
      requests += 1
      return Response.json({ apps: [app] })
    })
    const first = setup(client)
    const second = setup(client)

    await settle()

    expect(first.result.current.loading).toBe(false)
    expect(second.result.current.loading).toBe(false)
    expect(requests).toBe(1)
  })

  /** A transient failure must not cost the session its apps — holding the
   *  in-flight promise after a rejection left the tab empty until a reload. */
  it('retries on the next mount after a failure', async () => {
    let attempt = 0
    const client = clientWith(() => {
      attempt += 1
      return attempt === 1 ? new Response('nope', { status: 502 }) : Response.json({ apps: [app] })
    })

    const first = setup(client)
    await settle()
    expect(first.result.current.failed).toBe(true)
    first.unmount()

    const second = setup(client)
    await settle()

    expect(second.result.current.apps).toHaveLength(1)
    expect(second.result.current.failed).toBe(false)
  })
})
