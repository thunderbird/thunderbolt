/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { fetchMyApprovalSession, revealApprovalSession, startApprovalSession } from '@/api/encryption'
import { useHttpClient } from '@/contexts'
import {
  createApprovalCommitment,
  createApprovalNonce,
  createApprovalSessionId,
  deriveApprovalCode,
} from '@/crypto/device-approval-code'
import { HttpError } from '@/lib/http'
import { getThisDeviceApprovalCodeContext } from '@/services/encryption'
import { approvalSessionTtlMs } from '@shared/e2ee-types'
import { useEffect, useEffectEvent, useReducer, useRef } from 'react'

export type ApprovalCodeSessionStatus = 'starting' | 'waiting' | 'showing' | 'expired' | 'failed' | 'unavailable'

type State = {
  sessionId: string
  /** nB: memory only, committed to before any challenge is seen. */
  reveal: string
  startedAt: number | null
  status: ApprovalCodeSessionStatus
  code: string | null
  /** The first challenge for this session. Recorded before the reveal goes out; later ones are ignored. */
  challenge: { value: string; challengerDeviceId: string } | null
  revealed: boolean
}

type Action =
  | { type: 'started'; sessionId: string; at: number }
  | { type: 'challenged'; sessionId: string; challenge: NonNullable<State['challenge']>; code: string }
  | { type: 'revealed'; sessionId: string }
  | { type: 'expired'; sessionId: string }
  | { type: 'failed'; sessionId: string }
  | { type: 'unavailable'; sessionId: string }
  | { type: 'new-code'; sessionId: string; reveal: string }

const createAttempt = (sessionId: string, reveal: string): State => ({
  sessionId,
  reveal,
  startedAt: null,
  status: 'starting',
  code: null,
  challenge: null,
  revealed: false,
})

const createInitialState = (): State => createAttempt(createApprovalSessionId(), createApprovalNonce())

const reducer = (state: State, action: Action): State => {
  if (action.type === 'new-code') {
    return createAttempt(action.sessionId, action.reveal)
  }
  // An answer for an attempt the user already replaced ("New code") must not leak into the new one.
  if (action.sessionId !== state.sessionId) {
    return state
  }
  switch (action.type) {
    case 'started':
      return { ...state, status: 'waiting', startedAt: action.at }
    case 'challenged':
      return state.challenge ? state : { ...state, status: 'showing', challenge: action.challenge, code: action.code }
    case 'revealed':
      return { ...state, revealed: true }
    case 'expired':
      return { ...state, status: 'expired' }
    case 'failed':
      return { ...state, status: 'failed' }
    case 'unavailable':
      return { ...state, status: 'unavailable' }
  }
}

type UseApprovalCodeSessionOptions = {
  /** Injected in tests; production builds the context from this device's local keys. */
  getContext?: (sessionId: string) => Promise<string>
}

const pollMs = 1500

/**
 * The new device's side of the short-code approval: commit, wait for the trusted device's
 * challenge, reveal once, show the code. Without local keys or with a backend that lacks the relay
 * it is `unavailable` and the screen shows the fingerprint. Any other failure to start, or an
 * attempt replaced on the server, is `failed`, and "New code" retries.
 */
export const useApprovalCodeSession = ({
  getContext = getThisDeviceApprovalCodeContext,
}: UseApprovalCodeSessionOptions = {}) => {
  const httpClient = useHttpClient()
  const [state, dispatch] = useReducer(reducer, undefined, createInitialState)
  const isTicking = useRef(false)
  /** The attempt on screen, and whether the screen is still mounted: no reveal goes out for any other. */
  const liveSessionId = useRef(state.sessionId)
  liveSessionId.current = state.sessionId
  const isMounted = useRef(false)

  /** Without its keys this device can still be approved with the fingerprint, so log and fall back. */
  const loadContext = async (sessionId: string) => {
    try {
      return await getContext(sessionId)
    } catch (error) {
      console.error('Failed to prepare an approval code:', error)
      return null
    }
  }

  const start = useEffectEvent(async () => {
    const { sessionId, reveal } = state
    const context = await loadContext(sessionId)
    if (context === null) {
      dispatch({ type: 'unavailable', sessionId })
      return
    }
    try {
      await startApprovalSession(httpClient, { sessionId, commitment: await createApprovalCommitment(context, reveal) })
      dispatch({ type: 'started', sessionId, at: Date.now() })
    } catch (error) {
      const relayMissing = error instanceof HttpError && error.response.status === 404
      dispatch({ type: relayMissing ? 'unavailable' : 'failed', sessionId })
    }
  })

  const sendReveal = async (sessionId: string, reveal: string) => {
    if (!isMounted.current || liveSessionId.current !== sessionId) {
      return
    }
    try {
      await revealApprovalSession(httpClient, { sessionId, reveal })
      dispatch({ type: 'revealed', sessionId })
    } catch (error) {
      // 409: already revealed or expired. Either way nothing is left to send.
      if (error instanceof HttpError && error.response.status === 409) {
        dispatch({ type: 'revealed', sessionId })
      }
    }
  }

  const tick = useEffectEvent(async () => {
    const { sessionId, reveal, startedAt, challenge, revealed } = state
    const isPastTtl = () => startedAt !== null && Date.now() - startedAt >= approvalSessionTtlMs
    if (isPastTtl()) {
      dispatch({ type: 'expired', sessionId })
      return
    }
    if (challenge) {
      if (!revealed) {
        await sendReveal(sessionId, reveal)
      }
      return
    }
    const row = await fetchMyApprovalSession(httpClient)
    // Another start replaced this attempt on the server (a start that timed out here, or another tab),
    // so no trusted device can challenge it any more: offer a new code.
    if (row.sessionId !== sessionId) {
      dispatch({ type: 'failed', sessionId })
      return
    }
    if (row.expired) {
      dispatch({ type: 'expired', sessionId })
      return
    }
    if (!row.challenge || !row.challengerDeviceId) {
      return
    }
    const recorded = { value: row.challenge, challengerDeviceId: row.challengerDeviceId }
    const code = await deriveApprovalCode(
      await getContext(sessionId),
      recorded.challengerDeviceId,
      recorded.value,
      reveal,
    )
    // Checked again after the awaits: a challenge that arrives past the TTL (a held poll, a suspended
    // app) shows no code and gets no reveal.
    if (isPastTtl()) {
      dispatch({ type: 'expired', sessionId })
      return
    }
    dispatch({ type: 'challenged', sessionId, challenge: recorded, code })
    await sendReveal(sessionId, reveal)
  })

  // Legitimate useEffect: async operation when an attempt begins (mount, or "New code").
  useEffect(() => {
    void start()
  }, [state.sessionId])

  // Legitimate useEffect: mount tracking, so an in-flight poll cannot reveal after the screen is gone.
  useEffect(() => {
    isMounted.current = true
    return () => {
      isMounted.current = false
    }
  }, [])

  const isPolling = state.status === 'waiting' || state.status === 'showing'

  // Legitimate useEffect: polling timer with cleanup.
  useEffect(() => {
    if (!isPolling) {
      return
    }
    const intervalId = setInterval(async () => {
      if (isTicking.current) {
        return
      }
      isTicking.current = true
      try {
        await tick()
      } catch {
        // A failed poll is transient; the next tick retries.
      } finally {
        isTicking.current = false
      }
    }, pollMs)
    return () => clearInterval(intervalId)
  }, [isPolling])

  const newCode = () =>
    dispatch({ type: 'new-code', sessionId: createApprovalSessionId(), reveal: createApprovalNonce() })

  return { status: state.status, code: state.code, newCode }
}
