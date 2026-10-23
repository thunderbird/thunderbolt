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
import type { SessionState, VoiceSession } from '@/voice/session'
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

type VoiceUiState = {
  active: boolean
  state: SessionState
  error: string | null
}

const initial: VoiceUiState = { active: false, state: 'idle', error: null }

/** Keep the audio graph out of the composer's entry bundle until voice starts. */
const loadVoiceRuntime = async () => {
  const [{ createVoiceSession }, { createVoiceEngine }, { createChatReply }] = await Promise.all([
    import('@/voice/session'),
    import('@/voice/engine/router'),
    import('@/voice/chat-reply'),
  ])
  return { createVoiceSession, createVoiceEngine, createChatReply }
}

type VoiceRun = { controller: AbortController; session: VoiceSession | null }

export const useVoiceSession = (loadRuntime = loadVoiceRuntime) => {
  const session = useCurrentChatSession()
  const { i18n: activeI18n } = useLingui()
  const unavailableMessage = agentVoiceUnavailableMessage(session.selectedAgent)
  const unavailableReason = unavailableMessage ? activeI18n._(unavailableMessage) : null
  const [ui, patch] = useReducer((s: VoiceUiState, p: Partial<VoiceUiState>): VoiceUiState => ({ ...s, ...p }), initial)
  const runRef = useRef<VoiceRun | null>(null)
  // Live mic level, updated ~30×/s. A ref (not state) so the waveform can read it
  // in a rAF loop without re-rendering the composer on every frame.
  const levelRef = useRef(0)
  // Live TTS output level for the speaking-state waveform. A stable object whose
  // getter pulls from the current session's playback analyser on each rAF read
  // (pull, not push — mirrors how `levelRef` carries the mic level via onLevel).
  const outputLevelRef = useMemo<{ readonly current: number }>(
    () => ({
      get current() {
        return runRef.current?.session?.getOutputLevel() ?? 0
      },
    }),
    [],
  )

  // Tear the session down when the composer unmounts (chat navigation, HMR).
  // Without this the mic/VAD/AudioContext survive as an orphan bound to the old
  // chat — start again elsewhere and one utterance hits two chats at once.
  useEffect(
    () => () => {
      const run = runRef.current
      runRef.current = null
      run?.controller.abort()
      void run?.session?.stop()
      setVoiceModeActive(false)
    },
    [],
  )

  const start = async () => {
    if (runRef.current) {
      return
    }
    const run: VoiceRun = { controller: new AbortController(), session: null }
    runRef.current = run
    patch({ active: true, error: null, state: 'idle' })
    try {
      const currentSession = useChatStore.getState().sessions.get(session.id)
      if (!currentSession) {
        throw new VoiceAgentChangedError()
      }
      assertSessionCanSend(currentSession)
      const unavailable = agentVoiceUnavailableMessage(currentSession.selectedAgent)
      if (unavailable) {
        runRef.current = null
        patch({ error: activeI18n._(unavailable) })
        return
      }
      const agentId = currentSession.selectedAgent.id
      setVoiceModeActive(true)
      const { createVoiceSession, createVoiceEngine, createChatReply } = await loadRuntime()
      if (run.controller.signal.aborted) {
        return
      }
      const liveSession = useChatStore.getState().sessions.get(session.id)
      if (!liveSession || liveSession.selectedAgent.id !== agentId) {
        throw new VoiceAgentChangedError()
      }
      assertSessionCanSend(liveSession)
      const voice = createVoiceSession({
        engine: createVoiceEngine(liveSession.selectedAgent),
        // The transcript + reply render as normal chat bubbles via sendMessage, so
        // the UI itself only needs the session state.
        reply: createChatReply(toReplyChat(liveSession.chatInstance, session.id, agentId)),
        onState: (state) => {
          if (!run.controller.signal.aborted) {
            patch({ state })
          }
        },
        onError: (error) => {
          console.error('[voice]', error)
          if (!run.controller.signal.aborted) {
            patch({ error: toVoiceOverlayError(error) })
          }
        },
        onLevel: (level) => {
          levelRef.current = level
        },
      })
      run.session = voice
      await voice.start()
      if (run.controller.signal.aborted) {
        return
      }
      const startedSession = useChatStore.getState().sessions.get(session.id)
      if (!startedSession || startedSession.selectedAgent.id !== agentId) {
        throw new VoiceAgentChangedError()
      }
      useChatStore.getState().updateSession(session.id, { agentLocked: true })
    } catch (error) {
      if (run.controller.signal.aborted) {
        return
      }
      // Startup failures are usually getUserMedia (mic blocked / missing / in use)
      // — surface an actionable message instead of a raw DOMException name. Tear
      // the partial session down (its playback ctx already exists) and clear the
      // ref so the mic button can start a fresh one.
      console.error('[voice]', error)
      await run.session?.stop()
      if (run.controller.signal.aborted) {
        return
      }
      runRef.current = null
      setVoiceModeActive(false)
      patch({
        error: error instanceof VoiceAgentChangedError ? toVoiceOverlayError(error) : toVoiceErrorMessage(error),
      })
    }
  }

  const stop = async () => {
    const run = runRef.current
    runRef.current = null
    run?.controller.abort()
    setVoiceModeActive(false)
    patch({ active: false, state: 'idle' })
    await run?.session?.stop()
  }

  return { ...ui, available: unavailableMessage === null, unavailableReason, start, stop, levelRef, outputLevelRef }
}
