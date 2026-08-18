/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { Session } from '@/contexts/auth-context'
import { getPlatform } from '@/lib/platform'
import type { ThunderboltUIMessage } from '@/types'
import { extractDebugTranscriptToolCalls } from './message-tool-calls'
import { getDebugTranscriptCaptureStatus, getDebugTranscriptNotes } from './recorder'
import { sanitizeDebugTranscriptSecrets } from './sanitizer'
import type {
  DebugTranscriptMessageMetadataV1,
  DebugTranscriptPayloadV1,
  DebugTranscriptTurnNotes,
  DebugTranscriptTurnV1,
} from './types'

const maxPayloadBytes = 1_500_000
const payloadEncoder = new TextEncoder()

export type BuildDebugTranscriptPayloadInput = {
  threadId: string
  messages: readonly ThunderboltUIMessage[]
  authSession: { user: Pick<Session['user'], 'id' | 'email'> } | null
  appVersion?: string
  platform?: string
  capturedAt?: string
}

type PersistedTurnMessages = {
  user: ThunderboltUIMessage | null
  assistants: ThunderboltUIMessage[]
}

const textFromMessage = (message: ThunderboltUIMessage): string =>
  message.parts.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('')

const groupMessagesByTurn = (messages: readonly ThunderboltUIMessage[]): PersistedTurnMessages[] => {
  const turns: PersistedTurnMessages[] = []
  for (const message of messages) {
    if (message.role === 'user') {
      turns.push({ user: message, assistants: [] })
      continue
    }
    if (message.role === 'assistant') {
      const current = turns.at(-1)
      if (current) {
        current.assistants.push(message)
      } else {
        turns.push({ user: null, assistants: [message] })
      }
    }
  }
  return turns
}

const metadataFromTurn = ({ user, assistants }: PersistedTurnMessages): DebugTranscriptMessageMetadataV1 | null =>
  assistants.findLast(({ metadata }) => metadata?.debugTranscript)?.metadata?.debugTranscript ??
  user?.metadata?.debugTranscript ??
  null

const notesForTurn = (
  messages: PersistedTurnMessages,
  metadata: DebugTranscriptMessageMetadataV1 | null,
  notes: readonly DebugTranscriptTurnNotes[],
): DebugTranscriptTurnNotes | undefined => {
  const userMessageId = messages.user?.id
  return (
    (metadata !== null ? notes.findLast((candidate) => candidate.traceId === metadata.traceId) : undefined) ??
    (userMessageId !== undefined ? notes.findLast((candidate) => candidate.userMessageId === userMessageId) : undefined)
  )
}

const assembleTurn = (
  messages: PersistedTurnMessages,
  notes: readonly DebugTranscriptTurnNotes[],
): DebugTranscriptTurnV1 => {
  const metadata = metadataFromTurn(messages)
  const attached = notesForTurn(messages, metadata, notes)
  const assistant = messages.assistants.at(-1)
  const assistantText = messages.assistants.map(textFromMessage).join('')
  const userMessageId = messages.user?.id ?? null
  return {
    traceId:
      metadata?.traceId ??
      attached?.traceId ??
      (userMessageId ? `persisted:${userMessageId}` : `persisted:assistant:${assistant?.id}`),
    source: attached ? 'live' : 'persisted',
    engine: metadata?.engine ?? attached?.engine ?? 'legacy',
    model: {
      id:
        metadata?.modelId ??
        attached?.model.id ??
        assistant?.metadata?.modelId ??
        messages.user?.metadata?.modelId ??
        null,
      name: metadata?.modelName ?? attached?.model.name ?? null,
      provider: metadata?.provider ?? attached?.model.provider ?? null,
    },
    agentId: metadata?.agentId ?? attached?.agentId ?? null,
    userMessageId,
    assistantMessageId: assistant?.id ?? null,
    userPrompt: { text: messages.user ? textFromMessage(messages.user) : '', timestamp: null },
    systemPrompts: attached?.systemPrompts ?? [],
    assistantOutput: assistantText ? { text: assistantText, timestamp: null } : null,
    toolCalls: messages.assistants.flatMap(extractDebugTranscriptToolCalls),
    failures: attached?.failures ?? [],
    startedAt: attached?.startedAt ?? null,
    endedAt: attached?.endedAt ?? null,
    outcome: attached?.outcome ?? null,
  }
}

const serializedPayloadBytes = (payload: DebugTranscriptPayloadV1): number =>
  payloadEncoder.encode(JSON.stringify(payload)).byteLength

const boundPayload = (payload: DebugTranscriptPayloadV1): DebugTranscriptPayloadV1 => {
  while (payload.turns.length > 1 && serializedPayloadBytes(payload) > maxPayloadBytes) {
    payload.turns.shift()
  }
  return payload
}

/**
 * Walk persisted messages in order, staple session-only notes onto their turns,
 * sanitize the complete result, then enforce the upload limit.
 */
export const buildDebugTranscriptPayload = ({
  threadId,
  messages,
  authSession,
  appVersion = import.meta.env.VITE_APP_VERSION ?? 'unknown',
  platform = getPlatform(),
  capturedAt = new Date().toISOString(),
}: BuildDebugTranscriptPayloadInput): DebugTranscriptPayloadV1 => {
  const notes = getDebugTranscriptNotes(threadId)
  const payload: DebugTranscriptPayloadV1 = {
    schemaVersion: 1,
    capture: { capturedAt, appVersion, platform, ...getDebugTranscriptCaptureStatus() },
    identity: {
      userId: authSession?.user.id ?? null,
      email: authSession?.user.email ?? null,
    },
    thread: { threadId },
    turns: groupMessagesByTurn(messages).map((turn) => assembleTurn(turn, notes)),
  }
  return boundPayload(sanitizeDebugTranscriptSecrets(payload))
}
