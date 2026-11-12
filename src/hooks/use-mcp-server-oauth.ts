/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { i18n } from '@/i18n'
import { msg } from '@lingui/core/macro'
import type { AnyDrizzleDatabase } from '@/db/database-interface'
import { deleteMcpServer } from '@/dal'
import { McpAuthorizationChangedError, saveMcpAuthorizationCredentials } from '@/dal/mcp-secrets'
import { getIdentitySignal } from '@/lib/identity-lifetime'
import { clearMcpOAuthState, getMcpOAuthState } from '@/lib/mcp-auth/mcp-oauth-state'
import { completeMcpOAuthFlow, startMcpOAuthFlow } from '@/lib/mcp-auth/web-oauth-flow'
import type { FetchFn } from '@/lib/proxy-fetch'
import { useReducer, useRef } from 'react'
import { useAuthAttempt } from './use-auth-attempt'

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
    return i18n._(msg`Authorization was declined.`)
  }
  return i18n._(msg`Authorization failed. Please try again.`)
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
  | { type: 'cancel' }

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
    case 'cancel':
      return {
        ...state,
        isAddAuthorizePending: false,
        cards: Object.fromEntries(Object.entries(state.cards).filter(([, card]) => card.phase !== 'authorizing')),
      }
    default:
      return state
  }
}

/** Side effects `handleMcpOAuthCallback` performs, injected so it stays React-free and testable. */
export type McpOAuthCallbackDeps = {
  completeMcpOAuthFlow: typeof completeMcpOAuthFlow
  reconnectServer: (serverId: string) => Promise<unknown>
  fetchFn: FetchFn
  signal?: AbortSignal
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
  const { serverId, serverUrl } = getMcpOAuthState()
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
    deps.setCard(serverId, { phase: 'error', message: i18n._(msg`Authorization was cancelled.`) })
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
      signal: deps.signal,
      ...(deps.signal
        ? {
            saveCredentials: (credentials) =>
              saveMcpAuthorizationCredentials(db, serverId, serverUrl ?? '', credentials, deps.signal!),
          }
        : {}),
    })
    deps.setCard(serverId, null)
    await deps.reconnectServer(serverId)
  } catch (error) {
    if (deps.signal?.aborted) {
      return
    }
    console.error('Failed to complete MCP OAuth flow:', error)
    deps.setCard(serverId, {
      phase: 'error',
      message: errorMessage(error, i18n._(msg`Authorization failed.`)),
    })
  }
}

const errorMessage = (error: unknown, fallback: string): string =>
  error instanceof McpAuthorizationChangedError
    ? i18n._(msg`This connection changed during authorization. Please try again.`)
    : error instanceof Error
      ? error.message
      : fallback

/** Dependencies for {@link useMcpServerOAuth}. The flow primitives default to the
 *  real implementations and are overridable in tests. */
export type UseMcpServerOAuthOptions = {
  db: AnyDrizzleDatabase
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
  cancelAuthorization: () => void
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
    buildOAuthFetch,
    reconnectServer,
    clearNavState,
    startMcpOAuthFlow: startFlow = startMcpOAuthFlow,
    completeMcpOAuthFlow: completeFlow = completeMcpOAuthFlow,
  } = options
  const [state, dispatch] = useReducer(oauthReducer, initialState)
  // Discovery yields before the OAuth nonce is persisted. All entry points
  // share one reservation so no second flow can overwrite that handshake.
  const operation = useAuthAttempt()
  const redirectedNonce = useRef<string | null>(null)
  const rememberRedirect = (serverId: string) => {
    const pending = getMcpOAuthState()
    redirectedNonce.current = pending.serverId === serverId ? pending.stateNonce : null
    setCard(serverId, { phase: 'authorizing' })
  }
  const begin = () => {
    const attempt = operation.begin()
    if (!attempt) {
      return null
    }
    const identity = getIdentitySignal()
    const signal = AbortSignal.any([attempt.signal, identity])
    const fetch = buildOAuthFetch()
    const fetchFn: FetchFn = Object.assign(
      (input: RequestInfo | URL, init?: RequestInit) => {
        signal.throwIfAborted()
        const requestSignal = init?.signal ?? (input instanceof Request ? input.signal : undefined)
        return fetch(input, {
          ...init,
          signal: AbortSignal.any([signal, ...(requestSignal ? [requestSignal] : [])]),
        })
      },
      { preconnect: fetch.preconnect },
    )
    return { ...attempt, signal, identity, fetchFn, isCurrent: () => attempt.isCurrent() && !signal.aborted }
  }

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
    const attempt = begin()
    if (!attempt) {
      return
    }
    setCard(server.id, { phase: 'authorizing' })
    try {
      const result = await startFlow({
        db,
        serverId: server.id,
        serverUrl: server.url ?? '',
        fetchFn: attempt.fetchFn,
        signal: attempt.signal,
        saveCredentials: (credentials) =>
          saveMcpAuthorizationCredentials(db, server.id, server.url ?? '', credentials, attempt.signal),
      })
      if (attempt.isCurrent() && result.status === 'redirected') {
        rememberRedirect(server.id)
      }
      if (attempt.isCurrent() && result.status === 'completed') {
        setCard(server.id, null)
        await reconnectServer(server.id)
      }
    } catch (error) {
      if (!attempt.signal.aborted) {
        console.error('Failed to start MCP OAuth flow:', error)
      }
      if (attempt.isCurrent()) {
        setCard(server.id, {
          phase: 'error',
          message: errorMessage(error, i18n._(msg`Could not start authorization. Please try again.`)),
        })
      }
    } finally {
      attempt.finish()
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
    const attempt = begin()
    if (!attempt) {
      return false
    }
    dispatch({ type: 'clear-dialog-error' })
    dispatch({ type: 'set-add-authorize-pending', pending: true })
    const progress = { created: false, authorized: false }
    try {
      await createRow()
      progress.created = true
      attempt.signal.throwIfAborted()
      const result = await startFlow({
        db,
        serverId,
        serverUrl,
        fetchFn: attempt.fetchFn,
        signal: attempt.signal,
        saveCredentials: async (credentials) => {
          await saveMcpAuthorizationCredentials(db, serverId, serverUrl, credentials, attempt.signal)
          progress.authorized = true
        },
      })
      attempt.signal.throwIfAborted()
      if (!attempt.isCurrent()) {
        return false
      }
      if (result.status === 'redirected') {
        rememberRedirect(serverId)
      }
      if (result.status === 'completed') {
        progress.authorized = true
        // Authorization has committed. A runtime reconnect failure must keep
        // the server and its credentials so the user can retry the connection.
        try {
          await reconnectServer(serverId)
        } catch (error) {
          console.error('Failed to reconnect authorized MCP server:', error)
          if (attempt.isCurrent()) {
            setCard(serverId, {
              phase: 'error',
              message: errorMessage(error, i18n._(msg`Changes were saved, but reconnecting failed. Please retry.`)),
            })
          }
        }
      }
      return attempt.isCurrent()
    } catch (error) {
      if (!attempt.signal.aborted) {
        console.error('Failed to start MCP OAuth flow:', error)
      }
      // Explicit cancellation keeps a retryable row; a stale cancelled flow must not
      // delete a connection another authorization has already started using.
      if (progress.created && !progress.authorized && !attempt.signal.aborted) {
        try {
          await deleteMcpServer(db, serverId)
        } catch (rollbackError) {
          console.error('Failed to roll back MCP server after authorization error:', rollbackError)
        }
      }
      if (attempt.isCurrent()) {
        dispatch({
          type: 'set-dialog-error',
          message: errorMessage(error, i18n._(msg`Could not start authorization. Please try again.`)),
        })
      }
      return false
    } finally {
      if (attempt.isCurrent()) {
        dispatch({ type: 'set-add-authorize-pending', pending: false })
      }
      attempt.finish()
    }
  }

  const processCallback = async (oauth: McpOAuthCallback | undefined) => {
    const attempt = begin()
    if (!attempt) {
      return
    }
    try {
      await handleMcpOAuthCallback(oauth, db, {
        completeMcpOAuthFlow: completeFlow,
        reconnectServer: async (serverId) => {
          if (attempt.isCurrent()) {
            await reconnectServer(serverId)
          }
        },
        fetchFn: attempt.fetchFn,
        signal: attempt.signal,
        setCard: (serverId, card) => {
          if (attempt.isCurrent()) {
            setCard(serverId, card)
          }
        },
        clearNavState,
      })
    } finally {
      attempt.finish()
    }
  }

  return {
    cardStateFor: (serverId) => state.cards[serverId] ?? null,
    dialogError: state.dialogError,
    clearDialogError: () => dispatch({ type: 'clear-dialog-error' }),
    cancelAuthorization: () => {
      operation.cancel()
      if (redirectedNonce.current && getMcpOAuthState().stateNonce === redirectedNonce.current) {
        clearMcpOAuthState()
      }
      redirectedNonce.current = null
      dispatch({ type: 'cancel' })
    },
    isAddAuthorizePending: state.isAddAuthorizePending,
    startAuthorize,
    startAddAndAuthorize,
    processCallback,
  }
}
