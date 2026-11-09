/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * React lifecycle wrapper around the voice session (THU-689). Builds the session
 * from the current chat's `Chat` instance so a voice turn is a real chat turn,
 * and exposes the state/transcripts the overlay renders.
 */
import { useChatStore, useCurrentChatSession } from '@/chats/chat-store'
import { isPrivateAutoRunBlocked } from '@/chats/private-thread'
import { assertSessionCanSend } from '@/chats/session-policy'
import type { ThunderboltUIMessage } from '@/types'
import { agentVoiceUnavailableMessage } from '@/voice/agent-voice'
import type { ReplyChat } from '@/voice/chat-reply'
import type { SessionState } from '@/voice/session'
import { createSessionLifecycle } from './session-lifecycle'
import { setVoiceModeActive } from '@/voice/voice-mode'
import { toVoiceErrorMessage } from '@/voice/voice-error'
import type { Chat } from '@ai-sdk/react'
import { i18n } from '@lingui/core'
import { msg } from '@lingui/core/macro'
import { useLingui } from '@lingui/react/macro'
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

class VoiceAgentChangedError extends Error {
  constructor() {
    super('The agent for this voice session changed')
    this.name = 'VoiceAgentChangedError'
  }
}

/**
 * The line the voice overlay shows for a session error. A held private chat gets
 * the composer notice's translated copy, resolved now because the overlay stores
 * a string; any other error is shown as thrown.
 */
export const toVoiceOverlayError = (error: unknown): string => {
  if (error instanceof VoiceAgentChangedError) {
    return i18n._(msg`The agent for this voice session changed. Start voice mode again.`)
  }
  if (error instanceof PrivateChatHeldError) {
    const { agentName } = error
    return i18n._(msg`This private chat won't run on ${agentName}.`)
  }
  return String(error)
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
export const toReplyChat = (chat: Chat<ThunderboltUIMessage>, chatThreadId: string, agentId: string): ReplyChat => ({
  sendMessage: async (message) => {
    const session = useChatStore.getState().sessions.get(chatThreadId)
    if (!session || session.selectedAgent.id !== agentId) {
      throw new VoiceAgentChangedError()
    }
    if (
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

/** Keep the audio graph out of the composer's entry bundle until voice starts. */
const loadVoiceRuntime = async () => {
  const [{ createVoiceSession }, { createVoiceEngine }, { createChatReply }] = await Promise.all([
    import('@/voice/session'),
    import('@/voice/engine/router'),
    import('@/voice/chat-reply'),
  ])
  return { createVoiceSession, createVoiceEngine, createChatReply }
}

export const useVoiceSession = (loadRuntime = loadVoiceRuntime) => {
  const session = useCurrentChatSession()
  const { i18n: activeI18n } = useLingui()
  const unavailableMessage = agentVoiceUnavailableMessage(session.selectedAgent)
  const unavailableReason = unavailableMessage ? activeI18n._(unavailableMessage) : null
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
            error:
              error instanceof PrivateChatHeldError || error instanceof VoiceAgentChangedError
                ? toVoiceOverlayError(error)
                : toVoiceErrorMessage(error),
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
    lifecycle.start(async ({ signal, ...callbacks }) => {
      const currentSession = useChatStore.getState().sessions.get(session.id)
      if (!currentSession) {
        throw new VoiceAgentChangedError()
      }
      assertSessionCanSend(currentSession)
      const unavailable = agentVoiceUnavailableMessage(currentSession.selectedAgent)
      if (unavailable) {
        throw new Error(activeI18n._(unavailable))
      }
      const agentId = currentSession.selectedAgent.id
      const { createVoiceSession, createVoiceEngine, createChatReply } = await loadRuntime()
      signal.throwIfAborted()
      const liveSession = useChatStore.getState().sessions.get(session.id)
      if (!liveSession || liveSession.selectedAgent.id !== agentId) {
        throw new VoiceAgentChangedError()
      }
      assertSessionCanSend(liveSession)
      const voice = createVoiceSession({
        engine: createVoiceEngine(liveSession.selectedAgent),
        reply: createChatReply(toReplyChat(liveSession.chatInstance, session.id, agentId)),
        ...callbacks,
      })
      return {
        ...voice,
        start: async () => {
          await voice.start()
          signal.throwIfAborted()
          const startedSession = useChatStore.getState().sessions.get(session.id)
          if (!startedSession || startedSession.selectedAgent.id !== agentId) {
            throw new VoiceAgentChangedError()
          }
          useChatStore.getState().updateSession(session.id, { agentLocked: true })
        },
      }
    })

  return {
    available: unavailableMessage === null,
    unavailableReason,
    active: ui.phase !== 'closed',
    state: ui.phase === 'running' ? ui.state : ('idle' as const),
    error: ui.phase === 'failed' || ui.phase === 'running' ? ui.error : null,
    start,
    stop: lifecycle.stop,
    levelRef,
    outputLevelRef,
  }
}
