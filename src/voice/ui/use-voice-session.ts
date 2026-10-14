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
import type { SessionState, VoiceSession } from '@/voice/session'
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

type VoiceUiState = {
  active: boolean
  state: SessionState
  error: string | null
}

const initial: VoiceUiState = { active: false, state: 'idle', error: null }

export const useVoiceSession = () => {
  const session = useCurrentChatSession()
  const db = useDatabase()
  const [ui, patch] = useReducer((s: VoiceUiState, p: Partial<VoiceUiState>): VoiceUiState => ({ ...s, ...p }), initial)
  const sessionRef = useRef<VoiceSession | null>(null)
  // Live mic level, updated ~30×/s. A ref (not state) so the waveform can read it
  // in a rAF loop without re-rendering the composer on every frame.
  const levelRef = useRef(0)
  // Live TTS output level for the speaking-state waveform. A stable object whose
  // getter pulls from the current session's playback analyser on each rAF read
  // (pull, not push — mirrors how `levelRef` carries the mic level via onLevel).
  const outputLevelRef = useMemo<{ readonly current: number }>(
    () => ({
      get current() {
        return sessionRef.current?.getOutputLevel() ?? 0
      },
    }),
    [],
  )

  // Tear the session down when the composer unmounts (chat navigation, HMR).
  // Without this the mic/VAD/AudioContext survive as an orphan bound to the old
  // chat — start again elsewhere and one utterance hits two chats at once.
  useEffect(
    () => () => {
      void sessionRef.current?.stop()
      sessionRef.current = null
      setVoiceModeActive(false)
    },
    [],
  )

  const start = async () => {
    if (sessionRef.current) {
      return
    } // already running — never stack a second session
    patch({ active: true, error: null, state: 'idle' })
    // Flag voice as active so the chat send path injects the voice self-context
    // system note (see `voice-mode.ts`); cleared on stop / startup failure.
    setVoiceModeActive(true)
    try {
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
      const voice = createVoiceSession({
        engine: createVoiceEngine(experimentalFeatureVoice),
        // The transcript + reply render as normal chat bubbles via sendMessage, so
        // the UI itself only needs the session state.
        reply: createChatReply(toReplyChat(session.chatInstance, session.id)),
        onState: (state) => patch({ state }),
        onError: (error) => {
          console.error('[voice]', error)
          patch({ error: toVoiceOverlayError(error) })
        },
        onLevel: (level) => {
          levelRef.current = level
        },
      })
      sessionRef.current = voice
      await voice.start()
    } catch (error) {
      // Startup failures are usually getUserMedia (mic blocked / missing / in use)
      // — surface an actionable message instead of a raw DOMException name. Tear
      // the partial session down (its playback ctx already exists) and clear the
      // ref so the mic button can start a fresh one.
      console.error('[voice]', error)
      await sessionRef.current?.stop()
      sessionRef.current = null
      setVoiceModeActive(false)
      const { toVoiceErrorMessage } = await import('@/voice/voice-error')
      patch({ error: toVoiceErrorMessage(error) })
    }
  }

  const stop = async () => {
    await sessionRef.current?.stop()
    sessionRef.current = null
    setVoiceModeActive(false)
    patch({ active: false, state: 'idle' })
  }

  return { ...ui, start, stop, levelRef, outputLevelRef }
}
