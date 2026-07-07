/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { createModel } from '@/ai/fetch'
import type { FetchFn } from '@/lib/proxy-fetch'
import { useProxyFetchGetter } from '@/lib/proxy-fetch-context'
import type { Model } from '@/types'
import { generateText } from 'ai'
import { useCallback, useReducer, useRef } from 'react'

const connectionTestTimeoutMs = 10_000

export type ModelConnectionConfig = {
  provider: Model['provider']
  model: string
  url?: string | null
  apiKey?: string | null
}

type NormalizedConfig = {
  provider: Model['provider']
  model: string
  url: string | null
  apiKey: string | null
}

type ConnectionTestState = {
  isTesting: boolean
  rawStatus: 'idle' | 'success' | 'error'
  error: string | null
  tested: NormalizedConfig | null
}

type ConnectionTestAction =
  | { type: 'START'; tested: NormalizedConfig }
  | { type: 'SUCCESS'; tested: NormalizedConfig }
  | { type: 'FAILURE'; tested: NormalizedConfig; error: string }
  | { type: 'RESET' }

const initialState: ConnectionTestState = {
  isTesting: false,
  rawStatus: 'idle',
  error: null,
  tested: null,
}

const reducer = (_state: ConnectionTestState, action: ConnectionTestAction): ConnectionTestState => {
  switch (action.type) {
    case 'START':
      return { isTesting: true, rawStatus: 'idle', error: null, tested: action.tested }
    case 'SUCCESS':
      return { isTesting: false, rawStatus: 'success', error: null, tested: action.tested }
    case 'FAILURE':
      return { isTesting: false, rawStatus: 'error', error: action.error, tested: action.tested }
    case 'RESET':
      return initialState
  }
}

const normalize = (config: ModelConnectionConfig): NormalizedConfig => ({
  provider: config.provider,
  model: config.model,
  url: config.url || null,
  apiKey: config.apiKey || null,
})

/**
 * Probe that issues a real `generateText` round-trip against the configured
 * provider. Split out so tests can swap in a synchronous stub without touching
 * global module mocks.
 */
export type ConnectionTestProbe = (
  config: NormalizedConfig,
  getProxyFetch: () => FetchFn,
  signal: AbortSignal,
) => Promise<void>

const defaultProbe: ConnectionTestProbe = async (config, getProxyFetch, signal) => {
  const aiModel = await createModel(
    {
      id: 'test',
      name: 'Test Model',
      provider: config.provider,
      model: config.model,
      url: config.url,
      apiKey: config.apiKey,
      isSystem: 0,
      enabled: 1,
      toolUsage: 1,
      isConfidential: 0,
      startWithReasoning: 0,
      supportsParallelToolCalls: 1,
      contextWindow: null,
      deletedAt: null,
      defaultHash: null,
      vendor: null,
      description: null,
      userId: null,
    },
    getProxyFetch,
  )
  await generateText({
    model: aiModel,
    prompt: 'Say "test successful" if you can read this.',
    maxRetries: 0,
    abortSignal: signal,
  })
}

/**
 * Manages the state machine for a "Test Model" round-trip: idle → testing →
 * success/error. Returns `isTesting`, `status`, and `error` derived at render
 * time from the tested config vs. the current one: any credential divergence
 * collapses all three to their idle values in the same render, so a stale
 * `'success'` can't survive a credential edit and a mid-flight edit stops the
 * spinner immediately (no useEffect-based invalidation).
 *
 * The probe is bounded by a single 10s `AbortSignal.timeout` piped through
 * both the provider construction (via `Promise.race`) and the `generateText`
 * request (via `abortSignal`), so a hanging Tinfoil attestation or a stuck
 * `generateText` request both surface as a timeout error.
 */
export const useModelConnectionTest = (current: ModelConnectionConfig, probe: ConnectionTestProbe = defaultProbe) => {
  const getProxyFetch = useProxyFetchGetter()
  const [state, dispatch] = useReducer(reducer, initialState)
  const runIdRef = useRef(0)

  const test = useCallback(
    async (config: ModelConnectionConfig) => {
      const runId = ++runIdRef.current
      const isCurrent = () => runIdRef.current === runId

      const tested = normalize(config)
      dispatch({ type: 'START', tested })

      const timeoutSignal = AbortSignal.timeout(connectionTestTimeoutMs)
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutSignal.addEventListener('abort', () =>
          reject(new Error(`Connection test timed out after ${connectionTestTimeoutMs / 1000} seconds`)),
        )
      })
      const runPromise = probe(tested, getProxyFetch, timeoutSignal)

      try {
        await Promise.race([runPromise, timeoutPromise])
        if (!isCurrent()) {
          return
        }
        dispatch({ type: 'SUCCESS', tested })
      } catch (err) {
        console.error('Connection test error:', err)
        if (!isCurrent()) {
          return
        }
        dispatch({
          type: 'FAILURE',
          tested,
          error: err instanceof Error ? err.message : 'Failed to connect to model',
        })
      }
    },
    [getProxyFetch, probe],
  )

  const reset = useCallback(() => {
    runIdRef.current += 1
    dispatch({ type: 'RESET' })
  }, [])

  const normalizedCurrent = normalize(current)
  const matchesCurrent =
    state.tested !== null &&
    state.tested.provider === normalizedCurrent.provider &&
    state.tested.model === normalizedCurrent.model &&
    state.tested.url === normalizedCurrent.url &&
    state.tested.apiKey === normalizedCurrent.apiKey

  const status: 'idle' | 'success' | 'error' = matchesCurrent ? state.rawStatus : 'idle'
  const error = matchesCurrent ? state.error : null
  const isTesting = matchesCurrent && state.isTesting

  return { isTesting, status, error, test, reset }
}
