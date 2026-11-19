/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useReducer, useRef } from 'react'
import type { VoiceProviderConfig } from '@/stores/local-settings-store'
import { type DiscoveredModels, fetchOpenAiModels, testOpenAiConnection } from '@/voice/engine/openai-compatible-engine'

type ConnectionState = { status: 'idle' | 'testing' } | { status: 'ok' | 'error'; detail: string }
type State = {
  test: { id: number; key: string; result: ConnectionState } | null
  discovery: { id: number; key: string; models: DiscoveredModels | null; pending: boolean } | null
}
type Action =
  | { type: 'TEST'; id: number; key: string }
  | { type: 'TEST_RESULT'; id: number; result: Extract<ConnectionState, { detail: string }> }
  | { type: 'DISCOVER'; id: number; key: string }
  | { type: 'MODELS'; id: number; models: DiscoveredModels }

const reducer = (state: State, action: Action): State => {
  switch (action.type) {
    case 'TEST':
      return { ...state, test: { id: action.id, key: action.key, result: { status: 'testing' } } }
    case 'TEST_RESULT':
      return state.test?.id === action.id ? { ...state, test: { ...state.test, result: action.result } } : state
    case 'DISCOVER':
      return { ...state, discovery: { id: action.id, key: action.key, models: null, pending: true } }
    case 'MODELS':
      return state.discovery?.id === action.id
        ? { ...state, discovery: { ...state.discovery, models: action.models, pending: false } }
        : state
  }
}

/** Keep connection results tied to the tested configuration and discovery to its endpoint. */
export const useVoiceSettingsState = (
  config: VoiceProviderConfig,
  dependencies = { testOpenAiConnection, fetchOpenAiModels },
) => {
  const [state, dispatch] = useReducer(reducer, { test: null, discovery: null })
  const sequence = useRef(0)
  const sourceKey = JSON.stringify([config.kind, config.baseUrl, config.apiKey])
  const testKey = JSON.stringify([sourceKey, config.sttModel, config.ttsModel, config.ttsVoice])
  const runTest = async () => {
    const id = ++sequence.current
    dispatch({ type: 'TEST', id, key: testKey })
    const result = await dependencies.testOpenAiConnection(config)
    dispatch({ type: 'TEST_RESULT', id, result: { status: result.ok ? 'ok' : 'error', detail: result.detail } })
  }
  const loadModels = async () => {
    const id = ++sequence.current
    dispatch({ type: 'DISCOVER', id, key: sourceKey })
    const models = await dependencies.fetchOpenAiModels(config.baseUrl, config.apiKey)
    dispatch({ type: 'MODELS', id, models })
  }
  const conn: ConnectionState = state.test?.key === testKey ? state.test.result : { status: 'idle' }
  return {
    conn,
    models: state.discovery?.key === sourceKey ? state.discovery.models : null,
    loadingModels: state.discovery?.key === sourceKey && state.discovery.pending,
    runTest,
    loadModels,
  }
}
