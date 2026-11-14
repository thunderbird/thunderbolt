/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { getClock } from '@/testing-library'
import { act, cleanup, renderHook } from '@testing-library/react'
import { createMcpServer, getAllMcpServers } from '@/dal'
import { getDb } from '@/db/database'
import { resetTestDatabase, setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { clearMcpOAuthState, getMcpOAuthState, setMcpOAuthState } from '@/lib/mcp-auth/mcp-oauth-state'
import type { FetchFn } from '@/lib/proxy-fetch'
import { createRecordingClient } from '@/test-utils/http-client'
import { createQueryTestWrapper } from '@/test-utils/react-query'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock } from 'bun:test'
import {
  useMcpServerOAuth,
  type UseMcpServerOAuthOptions,
  friendlyOAuthError,
  handleMcpOAuthCallback,
  type McpOAuthCallback,
  type McpOAuthCallbackDeps,
  type OAuthCardState,
} from './use-mcp-server-oauth'

const fakeFetch = (async () => new Response()) as unknown as FetchFn

// Captures the card mutations the handler emits so each branch can be asserted by
// the structure it produces, instead of inspecting React state.
const makeDeps = (overrides: Partial<McpOAuthCallbackDeps> = {}) => {
  const cards: Array<{ serverId: string; card: OAuthCardState | null }> = []
  const completeMcpOAuthFlow = mock((_args: { serverId: string; code: string }) => Promise.resolve())
  const reconnectServer = mock(async () => null)
  const clearNavState = mock(() => {})
  const onAuthorized = mock((_serverId: string) => {})
  const deps: McpOAuthCallbackDeps = {
    completeMcpOAuthFlow: completeMcpOAuthFlow as unknown as McpOAuthCallbackDeps['completeMcpOAuthFlow'],
    reconnectServer,
    fetchFn: fakeFetch,
    setCard: (serverId, card) => cards.push({ serverId, card }),
    clearNavState,
    onAuthorized,
    ...overrides,
  }
  return { deps, cards, completeMcpOAuthFlow, reconnectServer, clearNavState, onAuthorized }
}

const lastCard = (cards: Array<{ serverId: string; card: OAuthCardState | null }>) => cards[cards.length - 1]?.card

beforeAll(async () => {
  await setupTestDatabase()
})

afterAll(async () => {
  await teardownTestDatabase()
})

beforeEach(async () => {
  await resetTestDatabase()
  clearMcpOAuthState()
  reports = createRecordingClient(() => '')
})

afterEach(async () => {
  cleanup()
  clearMcpOAuthState()
})

describe('friendlyOAuthError', () => {
  it('maps access_denied to a declined message', () => {
    expect(friendlyOAuthError('access_denied')).toBe('Authorization was declined.')
  })

  it('falls back to a generic message for other errors', () => {
    expect(friendlyOAuthError('server_error')).toBe('Authorization failed. Please try again.')
    expect(friendlyOAuthError(undefined)).toBe('Authorization failed. Please try again.')
  })
})

describe('handleMcpOAuthCallback', () => {
  const validCallback: McpOAuthCallback = { code: 'auth-code', state: 'nonce', iss: 'https://as.example.com' }

  it('does nothing when there is no oauth payload', async () => {
    const { deps, cards, clearNavState, completeMcpOAuthFlow } = makeDeps()
    await handleMcpOAuthCallback(undefined, getDb(), deps)
    expect(clearNavState).not.toHaveBeenCalled()
    expect(cards).toHaveLength(0)
    expect(completeMcpOAuthFlow).not.toHaveBeenCalled()
  })

  it('does not touch nav state or consume the payload when no MCP flow is pending', async () => {
    // A callback that isn't ours (no pending handshake) must be left untouched —
    // clearing nav state here would silently drop another flow's authorization code.
    const { deps, cards, clearNavState, completeMcpOAuthFlow } = makeDeps()
    await handleMcpOAuthCallback(validCallback, getDb(), deps)
    expect(clearNavState).not.toHaveBeenCalled()
    expect(cards).toHaveLength(0)
    expect(completeMcpOAuthFlow).not.toHaveBeenCalled()
  })

  it('clears nav state once the callback matches the pending handshake', async () => {
    setMcpOAuthState({ serverId: 'server-1', startedAt: Date.now() })
    const { deps, clearNavState } = makeDeps()
    await handleMcpOAuthCallback(validCallback, getDb(), deps)
    expect(clearNavState).toHaveBeenCalledTimes(1)
  })

  it('sets an error card and clears the handshake when the AS returned an error', async () => {
    setMcpOAuthState({ serverId: 'server-1', startedAt: Date.now() })
    const { deps, cards, completeMcpOAuthFlow } = makeDeps()

    await handleMcpOAuthCallback({ error: 'access_denied' }, getDb(), deps)

    expect(lastCard(cards)).toEqual({ phase: 'error', message: 'Authorization was declined.' })
    expect(completeMcpOAuthFlow).not.toHaveBeenCalled()
    expect(getMcpOAuthState().serverId).toBeNull()
  })

  it('sets a cancelled error card when the code is missing', async () => {
    setMcpOAuthState({ serverId: 'server-1', startedAt: Date.now() })
    const { deps, cards, completeMcpOAuthFlow } = makeDeps()

    await handleMcpOAuthCallback({ state: 'nonce' }, getDb(), deps)

    expect(lastCard(cards)).toEqual({ phase: 'error', message: 'Authorization was cancelled.' })
    expect(completeMcpOAuthFlow).not.toHaveBeenCalled()
    expect(getMcpOAuthState().serverId).toBeNull()
  })

  it('completes the flow, clears the card, and reconnects on success', async () => {
    setMcpOAuthState({ serverId: 'server-1', startedAt: Date.now() })
    const { deps, cards, completeMcpOAuthFlow, reconnectServer, onAuthorized } = makeDeps()

    await handleMcpOAuthCallback(validCallback, getDb(), deps)

    expect(onAuthorized).toHaveBeenCalledWith('server-1')
    expect(completeMcpOAuthFlow).toHaveBeenCalledTimes(1)
    expect(completeMcpOAuthFlow.mock.calls[0][0]).toMatchObject({
      serverId: 'server-1',
      code: 'auth-code',
      returnedState: 'nonce',
      returnedIss: 'https://as.example.com',
    })
    // First sets authorizing, then clears the card (null) after the exchange.
    expect(cards.map((c) => c.card)).toEqual([{ phase: 'authorizing' }, null])
    expect(reconnectServer).toHaveBeenCalledWith('server-1')
  })

  it('sets an error card carrying the failure message and does not reconnect when the exchange throws', async () => {
    setMcpOAuthState({ serverId: 'server-1', startedAt: Date.now() })
    const completeMcpOAuthFlow = mock(async () => {
      throw new Error('Authorization server changed between start and callback — authorization rejected.')
    })
    const { deps, cards, reconnectServer, onAuthorized } = makeDeps({
      completeMcpOAuthFlow: completeMcpOAuthFlow as unknown as McpOAuthCallbackDeps['completeMcpOAuthFlow'],
    })

    await handleMcpOAuthCallback(validCallback, getDb(), deps)

    expect(onAuthorized).not.toHaveBeenCalled()
    expect(lastCard(cards)).toEqual({
      phase: 'error',
      message: 'Authorization server changed between start and callback — authorization rejected.',
    })
    expect(reconnectServer).not.toHaveBeenCalled()
  })
})

let reports: ReturnType<typeof createRecordingClient>

const renderOAuth = (overrides: Partial<UseMcpServerOAuthOptions> = {}) => {
  const options: UseMcpServerOAuthOptions = {
    db: getDb(),
    buildOAuthFetch: () => fakeFetch,
    reconnectServer: mock(async () => {}),
    clearNavState: mock(() => {}),
    startMcpOAuthFlow: mock(async () => ({ status: 'completed' as const })),
    completeMcpOAuthFlow: mock(async () => {}),
    ...overrides,
  }
  return {
    ...renderHook(() => useMcpServerOAuth(options), {
      wrapper: createQueryTestWrapper({ httpClient: reports.client }),
    }),
    options,
  }
}

describe('useMcpServerOAuth ownership', () => {
  it('reserves one flow across existing-server, add, and callback entry points', async () => {
    const pending = Promise.withResolvers<{ status: 'completed' }>()
    const start = mock(() => pending.promise)
    const createRow = mock(async () => {})
    setMcpOAuthState({ serverId: 'first', startedAt: Date.now() })
    const { result, options } = renderOAuth({ startMcpOAuthFlow: start })
    const running = act(async () => {
      const first = result.current.startAuthorize({ id: 'first' })
      await result.current.startAuthorize({ id: 'second' })
      expect(await result.current.startAddAndAuthorize({ serverId: 'new', serverUrl: '', createRow })).toBe(false)
      await result.current.processCallback({ code: 'code' })
      pending.resolve({ status: 'completed' })
      await first
    })
    await running
    expect(start).toHaveBeenCalledTimes(1)
    expect(createRow).not.toHaveBeenCalled()
    expect(options.completeMcpOAuthFlow).not.toHaveBeenCalled()
    expect(options.reconnectServer).toHaveBeenCalledWith('first')
  })

  it('consumes a pending callback once and stops reconnecting after unmount', async () => {
    setMcpOAuthState({ serverId: 'first', startedAt: Date.now() })
    const pending = Promise.withResolvers<void>()
    const complete = mock(() => pending.promise)
    const { result, options, unmount } = renderOAuth({ completeMcpOAuthFlow: complete })
    const first = result.current.processCallback({ code: 'code' })
    await result.current.processCallback({ code: 'code' })
    expect(complete).toHaveBeenCalledTimes(1)
    unmount()
    pending.resolve()
    await first
    expect(options.reconnectServer).not.toHaveBeenCalled()
  })

  it('does not begin authorization if creation finishes after unmount', async () => {
    const pending = Promise.withResolvers<void>()
    const { result, options, unmount } = renderOAuth()
    const running = result.current.startAddAndAuthorize({
      serverId: 'new',
      serverUrl: '',
      createRow: () => pending.promise,
    })
    unmount()
    pending.resolve()
    expect(await running).toBe(false)
    expect(options.startMcpOAuthFlow).not.toHaveBeenCalled()
  })

  it('keeps an authorized server when reconnect fails', async () => {
    const { result } = renderOAuth({
      reconnectServer: async () => {
        throw new Error('offline')
      },
    })
    await act(async () => {
      expect(
        await result.current.startAddAndAuthorize({
          serverId: 'new',
          serverUrl: 'https://server.example',
          createRow: () => createMcpServer(getDb(), { id: 'new', name: 'Authorized' }),
        }),
      ).toBe(true)
    })
    expect(await getAllMcpServers(getDb())).toHaveLength(1)
    await getClock().runAllAsync()
    expect(reports.requests).toEqual(['audit/client-events'])
    expect(result.current.cardStateFor('new')).toEqual({ phase: 'error', message: 'offline' })
    expect(result.current.dialogError).toBeNull()
    expect(result.current.isAddAuthorizePending).toBe(false)
  })

  it('reports no removal when creating the row failed, since no server was ever added', async () => {
    const { result } = renderOAuth()
    await act(async () => {
      expect(
        await result.current.startAddAndAuthorize({
          serverId: 'never-created',
          serverUrl: 'https://server.example',
          createRow: async () => {
            throw new Error('storage unavailable')
          },
        }),
      ).toBe(false)
    })
    await getClock().runAllAsync()

    expect(reports.requests).toEqual([])
  })

  it('rolls back failed authorization and releases the reservation for retry', async () => {
    const start = mock(async () => {
      throw new Error('declined')
    })
    const { result } = renderOAuth({ startMcpOAuthFlow: start })
    for (const id of ['one', 'two']) {
      await act(async () => {
        expect(
          await result.current.startAddAndAuthorize({
            serverId: id,
            serverUrl: 'https://server.example',
            createRow: () => createMcpServer(getDb(), { id, name: id }),
          }),
        ).toBe(false)
      })
    }
    expect(start).toHaveBeenCalledTimes(2)
    expect(await getAllMcpServers(getDb())).toHaveLength(0)
    // Each rolled-back server is reported removed; no authorization completed, so nothing else.
    await getClock().runAllAsync()
    expect(reports.requests).toEqual(['audit/client-events', 'audit/client-events'])
    expect(result.current.dialogError).toBe('declined')
    expect(result.current.isAddAuthorizePending).toBe(false)
  })
})
