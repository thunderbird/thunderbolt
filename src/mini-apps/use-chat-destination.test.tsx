/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Where selecting an app-linked chat lands.
 *
 * Worth its own tests because two callers act on the answer without being able
 * to check it: every sidebar row navigates to whatever this returns, and
 * `ChatWithOrigin` turns it into a `<Navigate replace />`. A wrong branch either
 * strands a chat at `/chats/:id` — where the model answers about a surface that
 * isn't on screen and `get_app_context` has nothing to read — or bounces a
 * perfectly good URL at an app that cannot host it.
 */

import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import type { ReactNode } from 'react'
import { MemoryRouter } from 'react-router'

import { HttpClientProvider } from '@/contexts/http-client-context'
import { createAuthenticatedClient, type HttpClient } from '@/lib/http'
import { getClock } from '@/testing-library'
import { useChatDestination } from './use-chat-destination'
import { resetMiniAppsForTesting } from './use-mini-apps'

const app = {
  id: 'finance-model',
  name: 'Finance Model',
  description: 'Quarterly revenue.',
  icon: 'line-chart',
  url: 'http://localhost:5174',
  origin: 'http://localhost:5174',
}

const clientWith = (apps: unknown[]): HttpClient =>
  createAuthenticatedClient('http://localhost:8000', () => 'session-token', {
    // `HttpClientConfig['fetch']` is the narrow call signature the client
    // actually uses, so this needs no cast to the full `typeof fetch`.
    fetch: () => Promise.resolve(Response.json({ apps })),
  })

const setup = (apps: unknown[] = [app]) => {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <HttpClientProvider httpClient={clientWith(apps)}>
      <MemoryRouter>{children}</MemoryRouter>
    </HttpClientProvider>
  )
  return renderHook(() => useChatDestination(), { wrapper })
}

/** Let the registry's mount fetch settle — the shared clock, not a guessed
 *  number of microtasks. */
const settle = async () => {
  await act(async () => {
    await getClock().tickAsync(1)
  })
}

beforeEach(resetMiniAppsForTesting)
afterEach(resetMiniAppsForTesting)

describe('useChatDestination', () => {
  it('sends an ordinary chat to the chat route', () => {
    const { result } = setup()

    expect(result.current('thread-1', null)).toBe('/chats/thread-1')
  })

  it('sends a chat with no app to the chat route', () => {
    const { result } = setup()

    expect(result.current('thread-1')).toBe('/chats/thread-1')
  })

  /**
   * The registry arrives over the network, and while it is in flight an app
   * looks exactly like one that was deregistered. Falling back is the safe
   * answer here — callers that can afford to wait check `loading` themselves
   * rather than acting on this.
   */
  it('falls back while the registry has not answered', () => {
    const { result } = setup()

    expect(result.current('thread-1', 'finance-model')).toBe('/chats/thread-1')
  })

  it('opens the chat inside its app once the registry has landed', async () => {
    const { result } = setup()

    await settle()

    expect(result.current('thread-1', 'finance-model')).toBe('/apps/finance-model?chat=thread-1')
  })

  /** A chat whose app this deployment no longer runs still opens — the banner
   *  says where it came from instead. */
  it('falls back for an app that is not registered', async () => {
    const { result } = setup([])

    await settle()

    expect(result.current('thread-1', 'gone-app')).toBe('/chats/thread-1')
  })

  /** Both halves reach a URL, so both are escaped — the banner used to build
   *  this string by hand and skipped it. */
  it('escapes the app id and the thread id', async () => {
    const odd = { ...app, id: 'a b/c' }
    const { result } = setup([odd])

    await settle()

    expect(result.current('t?1&2', 'a b/c')).toBe('/apps/a%20b%2Fc?chat=t%3F1%262')
  })
})
