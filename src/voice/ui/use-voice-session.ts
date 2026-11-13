/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * React lifecycle wrapper around the voice session (THU-689). Builds the session
 * from the current chat's `Chat` instance so a voice turn is a real chat turn,
 * and exposes the state/transcripts the overlay renders.
 */
import { useCurrentChatSession } from '@/chats/chat-store'
import { useDatabase } from '@/contexts'
import { getSettings } from '@/dal'
import { showSignInModalEvent } from '@/hooks/use-credential-events'
import { hasServerAuthentication } from '@/lib/provider-mode'
import { getLocalSetting } from '@/stores/local-settings-store'
import type { ThunderboltUIMessage } from '@/types'
import type { ReplyChat } from '@/voice/chat-reply'
import type { SessionState } from '@/voice/session'
import { toVoiceErrorMessage } from '@/voice/voice-error'
import { createSessionLifecycle } from './session-lifecycle'
import { setVoiceModeActive } from '@/voice/voice-mode'
import type { Chat } from '@ai-sdk/react'
import { useEffect, useMemo, useReducer, useRef } from 'react'

/**
 * Adapt the AI SDK `Chat` to the structural `ReplyChat` slice the voice session
 * needs. `Chat` provides `sendMessage`/`messages`/`stop`, but its broader method
 * signatures mean TS won't infer the match — an explicit adapter keeps chat-reply
 * decoupled from the SDK and avoids an `as unknown as` cast at the call site.
 */
export const toReplyChat = (chat: Chat<ThunderboltUIMessage>): ReplyChat => ({
  sendMessage: async (message) => {
    await chat.sendMessage(message)
  },
  get messages() {
    return chat.messages
  },
  stop: () => chat.stop(),
})

type VoiceUiState =
  | { phase: 'closed' | 'starting' }
  | { phase: 'running'; state: SessionState; error: string | null }
  | { phase: 'failed'; error: string }

type VoiceUiAction =
  | { type: 'START' }
  | { type: 'STOP' }
  | { type: 'STATE'; state: SessionState }
  | { type: 'ERROR' | 'START_FAILED'; error: string }

/** UI transitions follow the currently owned voice attempt only. */
export const voiceUiReducer = (state: VoiceUiState, action: VoiceUiAction): VoiceUiState => {
  switch (action.type) {
    case 'START':
      return { phase: 'starting' }
    case 'STOP':
      return { phase: 'closed' }
    case 'STATE':
      if (state.phase === 'closed' || state.phase === 'failed') {
        return state
      }
      return { phase: 'running', state: action.state, error: state.phase === 'running' ? state.error : null }
    case 'START_FAILED':
      return { phase: 'failed', error: action.error }
    case 'ERROR':
      if (state.phase === 'closed') {
        return state
      }
      return state.phase === 'running' ? { ...state, error: action.error } : { phase: 'failed', error: action.error }
  }
}

export const useVoiceSession = () => {
  const session = useCurrentChatSession()
  const db = useDatabase()
  const [ui, dispatch] = useReducer(voiceUiReducer, { phase: 'closed' })
  // Live mic level, updated ~30×/s. A ref (not state) so the waveform can read it
  // in a rAF loop without re-rendering the composer on every frame.
  const levelRef = useRef(0)
  const lifecycle = useMemo(
    () =>
      createSessionLifecycle({
        onStarting: () => dispatch({ type: 'START' }),
        onStopped: () => {
          levelRef.current = 0
          dispatch({ type: 'STOP' })
        },
        onState: (state) => dispatch({ type: 'STATE', state }),
        onError: (error, terminal) => {
          console.error('[voice]', error)
          dispatch({
            type: terminal ? 'START_FAILED' : 'ERROR',
            error: toVoiceErrorMessage(error),
          })
        },
        onLevel: (level) => {
          levelRef.current = level
        },
        onActiveChange: setVoiceModeActive,
      }),
    [],
  )
  const outputLevelRef = useMemo(
    () => ({
      get current() {
        return lifecycle.getOutputLevel()
      },
    }),
    [lifecycle],
  )

  useEffect(
    () => () => {
      void lifecycle.stop()
    },
    [lifecycle],
  )

  const start = () =>
    lifecycle.start(async (callbacks, signal) => {
      // Lazy-load the voice runtime (session + engines + VAD/playback/aggregator
      // graph) only when the user actually starts voice — it's a non-critical
      // feature and must stay out of the always-mounted chat composer's entry
      // bundle. Read the flag authoritatively from the DB here too (not via a
      // reactive hook that returns `false` until its query resolves) so a custom
      // provider is never bypassed for the hardwired engine on a cold start.
      const [{ createVoiceSession }, { createVoiceEngine }, { createChatReply }, { experimentalFeatureVoice }] =
        await Promise.all([
          import('@/voice/session'),
          import('@/voice/engine/router'),
          import('@/voice/chat-reply'),
          getSettings(db, { experimental_feature_voice: false }),
        ])
      signal.throwIfAborted()
      const engine = createVoiceEngine(experimentalFeatureVoice)
      if (engine.id === 'thunderbolt' && (!getLocalSetting('cloudUrl') || !hasServerAuthentication())) {
        window.dispatchEvent(new CustomEvent(showSignInModalEvent))
        return null
      }
      return createVoiceSession({
        engine,
        reply: createChatReply(toReplyChat(session.chatInstance)),
        ...callbacks,
      })
    })

  return {
    active: ui.phase !== 'closed',
    state: ui.phase === 'running' ? ui.state : ('idle' as const),
    error: ui.phase === 'failed' || ui.phase === 'running' ? ui.error : null,
    start,
    stop: lifecycle.stop,
    levelRef,
    outputLevelRef,
  }
}
