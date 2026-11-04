/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useEffect, useReducer, useRef } from 'react'
import {
  suggestedResourceSelections,
  type AgentSetupSuggester,
  type AgentSetupSuggestion,
} from './agent-setup-suggestion'
import type { AgentDraft, AgentResource } from './types'

type AgentKind = 'thunderbolt' | 'acp'
type AddAgentState = {
  kind: AgentKind
  step: 'choose' | 'basics' | 'configure' | 'preview'
  hasOpenedAcp: boolean
  draft: AgentDraft
  edited: Partial<Record<keyof AgentDraft, boolean>>
  suggestedSelections: Record<string, boolean>
  suggestionStatus: 'idle' | 'pending' | 'ready' | 'error'
  requestId: number
}

type AddAgentAction =
  | { type: 'choose'; kind: AgentKind }
  | { type: 'continue' }
  | { type: 'back' }
  | { type: 'edit'; patch: Partial<Omit<AgentDraft, 'selections'>> }
  | { type: 'toggle'; id: string; selected: boolean }
  | { type: 'preview' }
  | { type: 'suggesting'; requestId: number }
  | {
      type: 'suggested'
      requestId: number
      suggestion: AgentSetupSuggestion
      resources: AgentResource[]
      desktopAvailable: boolean
    }
  | { type: 'suggestionFailed'; requestId: number }

const initialState: AddAgentState = {
  kind: 'thunderbolt',
  step: 'choose',
  hasOpenedAcp: false,
  edited: {},
  suggestedSelections: {},
  suggestionStatus: 'idle',
  requestId: 0,
  draft: { name: '', description: '', systemPrompt: '', environment: 'sandbox', access: 'approval', selections: {} },
}

/** Keep the draft intact when navigating between agent type, setup, and preview. */
export const addAgentReducer = (state: AddAgentState, action: AddAgentAction): AddAgentState => {
  switch (action.type) {
    case 'choose':
      return { ...state, kind: action.kind }
    case 'continue':
      if (state.step === 'basics') {
        return { ...state, step: 'configure' }
      }
      return {
        ...state,
        step: state.kind === 'thunderbolt' ? 'basics' : 'configure',
        hasOpenedAcp: state.hasOpenedAcp || state.kind === 'acp',
      }
    case 'back':
      if (state.step === 'preview') {
        return { ...state, step: 'configure' }
      }
      return { ...state, step: state.step === 'configure' && state.kind === 'thunderbolt' ? 'basics' : 'choose' }
    case 'edit': {
      const purposeChanged = action.patch.description !== undefined
      return {
        ...state,
        suggestionStatus: purposeChanged ? 'idle' : state.suggestionStatus,
        edited: { ...state.edited, ...Object.fromEntries(Object.keys(action.patch).map((key) => [key, true])) },
        draft: {
          ...state.draft,
          ...(purposeChanged && !state.edited.name ? { name: '' } : {}),
          ...action.patch,
        },
      }
    }
    case 'toggle':
      return {
        ...state,
        draft: { ...state.draft, selections: { ...state.draft.selections, [action.id]: action.selected } },
      }
    case 'preview':
      return { ...state, step: 'preview' }
    case 'suggesting':
      return { ...state, requestId: action.requestId, suggestionStatus: 'pending' }
    case 'suggestionFailed':
      return state.requestId === action.requestId && state.suggestionStatus === 'pending'
        ? { ...state, suggestionStatus: 'error' }
        : state
    case 'suggested':
      if (state.requestId !== action.requestId || state.suggestionStatus !== 'pending') {
        return state
      }
      return {
        ...state,
        suggestionStatus: 'ready',
        suggestedSelections: suggestedResourceSelections(action.suggestion, action.resources),
        draft: {
          ...state.draft,
          name: state.edited.name ? state.draft.name : action.suggestion.name,
          systemPrompt: state.edited.systemPrompt ? state.draft.systemPrompt : action.suggestion.systemPrompt,
          environment: state.edited.environment
            ? state.draft.environment
            : action.desktopAvailable && action.suggestion.environment === 'desktop'
              ? 'desktop'
              : 'sandbox',
        },
      }
  }
}

/** Resolve selections against the current catalog, excluding resources that disappeared. */
export const selectedAgentResources = (
  draft: AgentDraft,
  resources: AgentResource[],
  suggestions: Record<string, boolean> = {},
) =>
  resources.filter(
    (resource) =>
      !resource.disabled &&
      (draft.selections[resource.id] ?? suggestions[resource.id] ?? resource.defaultSelected ?? false),
  )

/** Own the creation flow independently of the panel surface or data source. */
export const useAddAgentState = (
  resources: AgentResource[],
  desktopAvailable: boolean,
  suggestSetup?: AgentSetupSuggester,
  cloud = false,
) => {
  const [state, dispatch] = useReducer(
    addAgentReducer,
    cloud
      ? {
          ...initialState,
          step: 'basics',
          edited: { environment: true },
          draft: { ...initialState.draft, environment: 'cloud' },
        }
      : initialState,
  )
  const request = useRef<{ signature: string; controller: AbortController } | null>(null)
  const requestId = useRef(0)
  // Only teardown touches the external request; user events own when it starts or changes.
  useEffect(() => () => request.current?.controller.abort(), [])
  const selectedResources = selectedAgentResources(state.draft, resources, state.suggestedSelections)
  const hasModel = selectedResources.some((resource) => resource.kind === 'model')
  const canContinueBasics =
    state.draft.description.trim().length > 0 &&
    (state.draft.environment === 'cloud' ||
      state.draft.environment === 'sandbox' ||
      (state.draft.environment === 'desktop' && desktopAvailable))
  const canPreview =
    canContinueBasics && hasModel && state.draft.name.trim().length > 0 && state.suggestionStatus !== 'pending'
  const showName = Boolean(
    state.draft.name ||
    state.edited.name ||
    state.suggestionStatus === 'error' ||
    (!suggestSetup && state.draft.description.trim()),
  )

  const suggestPurpose = async (description: string, retry = false) => {
    if (!suggestSetup || !description.trim()) {
      return
    }
    const input = {
      description: description.trim(),
      desktopAvailable,
    }
    const signature = JSON.stringify(input)
    if (!retry && request.current?.signature === signature) {
      return
    }
    request.current?.controller.abort()
    const controller = new AbortController()
    const id = ++requestId.current
    request.current = { signature, controller }
    dispatch({ type: 'suggesting', requestId: id })
    const timeout = setTimeout(() => {
      controller.abort()
      if (request.current?.controller === controller) {
        request.current = null
        dispatch({ type: 'suggestionFailed', requestId: id })
      }
    }, 30_000)
    controller.signal.addEventListener('abort', () => clearTimeout(timeout), { once: true })
    try {
      const suggestion = await suggestSetup(input, controller.signal)
      if (!controller.signal.aborted) {
        dispatch({ type: 'suggested', requestId: id, suggestion, resources, desktopAvailable })
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        console.warn('Agent setup suggestion failed', error instanceof Error ? error.name : 'Unknown error')
        request.current = null
        dispatch({ type: 'suggestionFailed', requestId: id })
      }
    } finally {
      clearTimeout(timeout)
    }
  }

  const suggest = (retry = false) => suggestPurpose(state.draft.description, retry)
  const edit = (patch: Partial<Omit<AgentDraft, 'selections'>>) => {
    if (patch.description !== undefined) {
      request.current?.controller.abort()
      request.current = null
    }
    dispatch({ type: 'edit', patch })
  }

  return {
    ...state,
    selectedResources,
    hasModel,
    canContinueBasics,
    canPreview,
    showName,
    suggest,
    selectStarter: (description: string) => {
      edit({ description })
      void suggestPurpose(description)
    },
    choose: (kind: AgentKind) => dispatch({ type: 'choose', kind }),
    next: () => {
      if (state.step === 'choose' || (state.step === 'basics' && canContinueBasics)) {
        if (state.step === 'basics') {
          void suggest()
        }
        dispatch({ type: 'continue' })
      }
    },
    back: () => dispatch({ type: 'back' }),
    edit,
    toggle: (id: string, selected: boolean) => dispatch({ type: 'toggle', id, selected }),
    preview: () => {
      if (canPreview) {
        dispatch({ type: 'preview' })
      }
    },
  }
}

export type AddAgentController = ReturnType<typeof useAddAgentState>
