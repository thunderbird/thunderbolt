/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { getDb } from '@/db/database'
import { resetTestDatabase, setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { clearMcpOAuthState, getMcpOAuthState, setMcpOAuthState } from '@/lib/mcp-auth/mcp-oauth-state'
import type { FetchFn } from '@/lib/proxy-fetch'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock } from 'bun:test'
import {
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
  const deps: McpOAuthCallbackDeps = {
    completeMcpOAuthFlow: completeMcpOAuthFlow as unknown as McpOAuthCallbackDeps['completeMcpOAuthFlow'],
    reconnectServer,
    fetchFn: fakeFetch,
    setCard: (serverId, card) => cards.push({ serverId, card }),
    clearNavState,
    ...overrides,
  }
  return { deps, cards, completeMcpOAuthFlow, reconnectServer, clearNavState }
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
})

afterEach(async () => {
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
    const { deps, cards, completeMcpOAuthFlow, reconnectServer } = makeDeps()

    await handleMcpOAuthCallback(validCallback, getDb(), deps)

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
    const { deps, cards, reconnectServer } = makeDeps({
      completeMcpOAuthFlow: completeMcpOAuthFlow as unknown as McpOAuthCallbackDeps['completeMcpOAuthFlow'],
    })

    await handleMcpOAuthCallback(validCallback, getDb(), deps)

    expect(lastCard(cards)).toEqual({
      phase: 'error',
      message: 'Authorization server changed between start and callback — authorization rejected.',
    })
    expect(reconnectServer).not.toHaveBeenCalled()
  })
})
