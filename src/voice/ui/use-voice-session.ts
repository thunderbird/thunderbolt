/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * React lifecycle wrapper around the voice session (THU-689). Builds the session
 * from the current chat's `Chat` instance so a voice turn is a real chat turn,
 * and exposes the state/transcripts the overlay renders.
 */
import { selectBuiltInAgentEnabled, useConfigStore } from '@/api/config-store'
import { useChatStore, useCurrentChatSession } from '@/chats/chat-store'
import { isPrivateAutoRunBlocked } from '@/chats/private-thread'
import { useDatabase } from '@/contexts'
import { builtInAgent } from '@/defaults/agents'
import { getSettings } from '@/dal'
import type { ThunderboltUIMessage } from '@/types'
import type { ReplyChat } from '@/voice/chat-reply'
import type { SessionState } from '@/voice/session'
import { toVoiceErrorMessage } from '@/voice/voice-error'
import { createSessionLifecycle } from './session-lifecycle'
import { setVoiceModeActive } from '@/voice/voice-mode'
import type { Chat } from '@ai-sdk/react'
import { i18n, type MessageDescriptor } from '@lingui/core'
import { msg } from '@lingui/core/macro'
import { useEffect, useMemo, useReducer, useRef } from 'react'

/** Thrown by a voice send the private auto-run hold refuses; `toVoiceOverlayError` translates it. */
class PrivateChatHeldError extends Error {
  readonly agentName: string

  constructor(agentName: string) {
    super(`This private chat won't run on ${agentName}`)
    this.name = 'PrivateChatHeldError'
    this.agentName = agentName
  }
}

// The composer notice's copy, so the overlay and the notice read alike in every locale.
const privateChatHeldMessage = (agentName: string, builtInAgentName: string | null): MessageDescriptor =>
  builtInAgentName
    ? msg`This private chat won't run on ${agentName}. Switch to ${builtInAgentName} to run it.`
    : msg`This private chat won't run on ${agentName}.`

/**
 * The line the voice overlay shows for a session error. A held private chat gets
 * the composer notice's translated copy, resolved now because the overlay stores
 * a string; any other error is shown as thrown.
 */
export const toVoiceOverlayError = (error: unknown): string => {
  if (!(error instanceof PrivateChatHeldError)) {
    return String(error)
  }
  const builtInAgentName = selectBuiltInAgentEnabled(useConfigStore.getState().config) ? builtInAgent.name : null
  return i18n._(privateChatHeldMessage(error.agentName, builtInAgentName))
}

/**
 * Adapt the AI SDK `Chat` to the structural `ReplyChat` slice the voice session
 * needs. `Chat` provides `sendMessage`/`messages`/`stop`, but its broader method
 * signatures mean TS won't infer the match — an explicit adapter keeps chat-reply
 * decoupled from the SDK and avoids an `as unknown as` cast at the call site.
 *
 * Each send re-checks the private auto-run hold against the live session, so a
 * voice session already running when the hold applies cannot carry a private
 * chat to a non-built-in agent either. The rejection lands in the session's
 * error state.
 */
export const toReplyChat = (chat: Chat<ThunderboltUIMessage>, chatThreadId: string): ReplyChat => ({
  sendMessage: async (message) => {
    const session = useChatStore.getState().sessions.get(chatThreadId)
    if (
      session &&
      isPrivateAutoRunBlocked({
        chatThread: session.chatThread,
        agent: session.selectedAgent,
        status: chat.status,
        stopping: session.stopping,
        lastRole: chat.messages.at(-1)?.role,
      })
    ) {
      throw new PrivateChatHeldError(session.selectedAgent.name)
    }
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
            error: error instanceof PrivateChatHeldError ? toVoiceOverlayError(error) : toVoiceErrorMessage(error),
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
    lifecycle.start(async (callbacks) => {
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
      return createVoiceSession({
        engine: createVoiceEngine(experimentalFeatureVoice),
        reply: createChatReply(toReplyChat(session.chatInstance, session.id)),
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
