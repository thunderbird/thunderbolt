/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { AnyDrizzleDatabase } from '@/db/database-interface'
import { deleteMcpServer } from '@/dal'
import { clearMcpOAuthState, getMcpOAuthState } from '@/lib/mcp-auth/mcp-oauth-state'
import { completeMcpOAuthFlow, startMcpOAuthFlow } from '@/lib/mcp-auth/web-oauth-flow'
import type { FetchFn } from '@/lib/proxy-fetch'
import { useReducer, useRef } from 'react'

/**
 * Per-server OAuth UI state. `needs-auth` / `authorized` are derived from the
 * live connection + stored credentials by the page; `authorizing` / `error` are
 * transient states this hook sets while a flow runs or fails.
 */
export type OAuthCardState =
  | { phase: 'authorizing' }
  | { phase: 'error'; message: string }
  | { phase: 'needs-auth'; message?: string }

/** OAuth callback payload carried back in `location.state` from `/oauth/callback`. */
export type McpOAuthCallback = { code?: string; state?: string; iss?: string; error?: string }

/** Maps a raw OAuth `error` query value to a short, user-facing message. */
export const friendlyOAuthError = (error?: string): string => {
  if (error === 'access_denied') {
    return 'Authorization was declined.'
  }
  return 'Authorization failed. Please try again.'
}

type OAuthStateShape = {
  /** Transient per-server card states keyed by server id. */
  cards: Record<string, OAuthCardState>
  /** Dialog-scoped error shown when "Add & Authorize" fails (the dialog stays open). */
  dialogError: string | null
  /** True while an Add & Authorize flow is running — disables the dialog button. */
  isAddAuthorizePending: boolean
}

type OAuthAction =
  | { type: 'set-authorizing'; serverId: string }
  | { type: 'set-error'; serverId: string; message: string }
  | { type: 'clear-card'; serverId: string }
  | { type: 'set-dialog-error'; message: string }
  | { type: 'clear-dialog-error' }
  | { type: 'set-add-authorize-pending'; pending: boolean }

const oauthReducer = (state: OAuthStateShape, action: OAuthAction): OAuthStateShape => {
  switch (action.type) {
    case 'set-authorizing':
      return { ...state, cards: { ...state.cards, [action.serverId]: { phase: 'authorizing' } } }
    case 'set-error':
      return { ...state, cards: { ...state.cards, [action.serverId]: { phase: 'error', message: action.message } } }
    case 'clear-card': {
      const cards = { ...state.cards }
      delete cards[action.serverId]
      return { ...state, cards }
    }
    case 'set-dialog-error':
      return { ...state, dialogError: action.message }
    case 'clear-dialog-error':
      return { ...state, dialogError: null }
    case 'set-add-authorize-pending':
      return { ...state, isAddAuthorizePending: action.pending }
    default:
      return state
  }
}

/** Side effects `handleMcpOAuthCallback` performs, injected so it stays React-free and testable. */
export type McpOAuthCallbackDeps = {
  completeMcpOAuthFlow: typeof completeMcpOAuthFlow
  reconnectServer: (serverId: string) => Promise<unknown>
  fetchFn: FetchFn
  /** Sets a server card to authorizing/error, or clears it when passed `null`. */
  setCard: (serverId: string, card: OAuthCardState | null) => void
  /** Clears the navigation state so a refresh can't reprocess the callback. */
  clearNavState: () => void
}

/**
 * Core OAuth-callback handler, kept pure (no React) so it can be unit-tested with
 * injected deps. Completes the flow when navigated back from `/oauth/callback`
 * with the code/state/iss in `location.state`. Branches:
 *  - no oauth payload, or no pending MCP handshake → noop (don't touch nav state:
 *    the payload may belong to another flow whose code we must not drop)
 *  - clears the nav state so a refresh can't reprocess the callback
 *  - `oauth.error` → error card (friendly message) + clear handshake
 *  - missing `oauth.code` → cancelled card + clear handshake
 *  - otherwise → authorizing card, exchange + persist, clear card, reconnect
 *  - exchange throws → error card carrying the failure message
 */
export const handleMcpOAuthCallback = async (
  oauth: McpOAuthCallback | undefined,
  db: AnyDrizzleDatabase,
  deps: McpOAuthCallbackDeps,
): Promise<void> => {
  if (!oauth) {
    return
  }

  // Only act on a callback that belongs to our pending handshake. Nonce-based
  // routing already keeps foreign (integrations) callbacks off this page; this
  // guard ensures that if one ever slips through we don't clear its nav state
  // (which would silently drop its code) or process it as ours.
  const { serverId } = getMcpOAuthState()
  if (!serverId) {
    return
  }
  // Clear the navigation state so a refresh can't reprocess the callback.
  deps.clearNavState()

  if (oauth.error) {
    deps.setCard(serverId, { phase: 'error', message: friendlyOAuthError(oauth.error) })
    clearMcpOAuthState()
    return
  }

  if (!oauth.code) {
    deps.setCard(serverId, { phase: 'error', message: 'Authorization was cancelled.' })
    clearMcpOAuthState()
    return
  }

  deps.setCard(serverId, { phase: 'authorizing' })
  try {
    await deps.completeMcpOAuthFlow({
      db,
      serverId,
      code: oauth.code,
      returnedState: oauth.state,
      returnedIss: oauth.iss,
      fetchFn: deps.fetchFn,
    })
    deps.setCard(serverId, null)
    await deps.reconnectServer(serverId)
  } catch (error) {
    console.error('Failed to complete MCP OAuth flow:', error)
    deps.setCard(serverId, {
      phase: 'error',
      message: error instanceof Error ? error.message : 'Authorization failed.',
    })
  }
}

const errorMessage = (error: unknown, fallback: string): string => (error instanceof Error ? error.message : fallback)

/** Dependencies for {@link useMcpServerOAuth}. The flow primitives default to the
 *  real implementations and are overridable in tests. */
export type UseMcpServerOAuthOptions = {
  db: AnyDrizzleDatabase
  /** Active workspace id — used to scope the rollback delete on Add & Authorize failure. */
  workspaceId: string | null | undefined
  /** Builds the proxy-routed fetch used for OAuth discovery/exchange. */
  buildOAuthFetch: () => FetchFn
  reconnectServer: (serverId: string) => Promise<unknown>
  /** Clears the OAuth callback navigation state (page-owned). */
  clearNavState: () => void
  startMcpOAuthFlow?: typeof startMcpOAuthFlow
  completeMcpOAuthFlow?: typeof completeMcpOAuthFlow
}

export type UseMcpServerOAuthResult = {
  /** Resolves the explicit transient card state for a server (or null if none). */
  cardStateFor: (serverId: string) => OAuthCardState | null
  dialogError: string | null
  clearDialogError: () => void
  isAddAuthorizePending: boolean
  startAuthorize: (server: { id: string; url?: string | null }) => Promise<void>
  /** Resolves `true` when the flow started/completed cleanly (caller can close the
   *  dialog), `false` when it failed and rolled back (dialog stays open with the error). */
  startAddAndAuthorize: (args: AddAndAuthorizeArgs) => Promise<boolean>
  processCallback: (oauth: McpOAuthCallback | undefined) => Promise<void>
}

type AddAndAuthorizeArgs = {
  serverId: string
  serverUrl: string
  /** Creates the server row. Run inside the re-entry guard so a synchronous
   *  double-click can't create a second row before the first finishes. */
  createRow: () => Promise<void>
}

const initialState: OAuthStateShape = { cards: {}, dialogError: null, isAddAuthorizePending: false }

/**
 * Owns the MCP Servers page OAuth state machine: the per-server transient card
 * states (`authorizing` / `error`), the Add-dialog error, and the three flows
 * that drive them (authorize an existing server, add-and-authorize a new one,
 * and complete the callback on redirect return). Mirrors `useOAuthConnect`'s
 * ergonomics so the page stays a thin consumer.
 */
export const useMcpServerOAuth = (options: UseMcpServerOAuthOptions): UseMcpServerOAuthResult => {
  const {
    db,
    workspaceId,
    buildOAuthFetch,
    reconnectServer,
    clearNavState,
    startMcpOAuthFlow: startFlow = startMcpOAuthFlow,
    completeMcpOAuthFlow: completeFlow = completeMcpOAuthFlow,
  } = options
  const [state, dispatch] = useReducer(oauthReducer, initialState)
  // Synchronous re-entry guard for Add & Authorize: a double-click (or Enter +
  // click) fires before the reducer's pending flag flushes, so the rendered flag
  // alone can't block the second call.
  const addAuthorizeInFlightRef = useRef(false)

  const setCard = (serverId: string, card: OAuthCardState | null) => {
    if (!card) {
      dispatch({ type: 'clear-card', serverId })
      return
    }
    if (card.phase === 'authorizing') {
      dispatch({ type: 'set-authorizing', serverId })
      return
    }
    if (card.phase === 'error') {
      dispatch({ type: 'set-error', serverId, message: card.message })
    }
  }

  /**
   * Begins (or restarts) the OAuth flow for an existing server: sets the card to
   * authorizing, records the return path, and runs the flow. Web/mobile navigate
   * away (`redirected`); desktop completes inline (`completed`) → clear card +
   * reconnect. On throw the card carries the thrown message so the concurrent-flow
   * guard surfaces, not a generic one.
   */
  const startAuthorize = async (server: { id: string; url?: string | null }) => {
    setCard(server.id, { phase: 'authorizing' })
    try {
      const result = await startFlow({
        db,
        serverId: server.id,
        serverUrl: server.url ?? '',
        fetchFn: buildOAuthFetch(),
      })
      if (result.status === 'completed') {
        setCard(server.id, null)
        await reconnectServer(server.id)
      }
    } catch (error) {
      console.error('Failed to start MCP OAuth flow:', error)
      setCard(server.id, {
        phase: 'error',
        message: errorMessage(error, 'Could not start authorization. Please try again.'),
      })
    }
  }

  /**
   * Creates the server row (via `createRow`) and runs its OAuth flow as one
   * guarded operation, so a synchronous double-click (or Enter + click) can't
   * create a second row before the first finishes. Web/mobile navigate away;
   * desktop completes inline → reconnect. On throw, rolls back the just-created
   * row and surfaces the failure in the dialog (which stays open).
   */
  const startAddAndAuthorize = async ({ serverId, serverUrl, createRow }: AddAndAuthorizeArgs): Promise<boolean> => {
    if (addAuthorizeInFlightRef.current) {
      return false
    }
    addAuthorizeInFlightRef.current = true
    dispatch({ type: 'clear-dialog-error' })
    dispatch({ type: 'set-add-authorize-pending', pending: true })
    try {
      await createRow()
      const result = await startFlow({ db, serverId, serverUrl, fetchFn: buildOAuthFetch() })
      if (result.status === 'completed') {
        await reconnectServer(serverId)
      }
      return true
    } catch (error) {
      console.error('Failed to start MCP OAuth flow:', error)
      if (workspaceId) {
        try {
          await deleteMcpServer(db, workspaceId, serverId)
        } catch (rollbackError) {
          console.error('Failed to roll back MCP server after authorization error:', rollbackError)
        }
      }
      dispatch({
        type: 'set-dialog-error',
        message: errorMessage(error, 'Could not start authorization. Please try again.'),
      })
      return false
    } finally {
      addAuthorizeInFlightRef.current = false
      dispatch({ type: 'set-add-authorize-pending', pending: false })
    }
  }

  const processCallback = (oauth: McpOAuthCallback | undefined) =>
    handleMcpOAuthCallback(oauth, db, {
      completeMcpOAuthFlow: completeFlow,
      reconnectServer,
      fetchFn: buildOAuthFetch(),
      setCard,
      clearNavState,
    })

  return {
    cardStateFor: (serverId) => state.cards[serverId] ?? null,
    dialogError: state.dialogError,
    clearDialogError: () => dispatch({ type: 'clear-dialog-error' }),
    isAddAuthorizePending: state.isAddAuthorizePending,
    startAuthorize,
    startAddAndAuthorize,
    processCallback,
  }
}
