/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }

export type DebugTranscriptEngine = 'pi' | 'legacy' | 'acp'
export type DebugTranscriptTurnSource = 'live' | 'persisted'
export type DebugTranscriptTurnOutcome = 'success' | 'error' | 'abort'
export type DebugTranscriptToolStatus = 'ok' | 'error' | 'incomplete'

export type DebugTranscriptTimestampV1 = {
  wallClock: string
  monotonicOffsetMs: number
}

export type DebugTranscriptModelV1 = {
  id: string | null
  name: string | null
  provider: string | null
}

export type DebugTranscriptModelIdentity = {
  id: string
  name: string
  provider: string
}

export type DebugTranscriptTextEventV1 = {
  text: string
  timestamp: DebugTranscriptTimestampV1 | null
}

export type DebugTranscriptSystemPromptV1 = {
  text: string
  attempt: number
  timestamp: DebugTranscriptTimestampV1
}

export type DebugTranscriptToolCallV1 = {
  toolCallId: string
  name: string
  arguments: JsonValue
  result: JsonValue
  status: DebugTranscriptToolStatus
  durationMs: number | null
}

export type DebugTranscriptFailureV1 = {
  errorClass: string | null
  message: string | null
  /** Total model attempts made, including the initial attempt. */
  attempt: number
  retryReasons: string[]
  aborted: boolean
  timestamp: DebugTranscriptTimestampV1
}

/** Session-only recorder state is not itself a versioned wire object. */
export type DebugTranscriptTurnNotes = {
  traceId: string
  userMessageId: string | null
  engine: DebugTranscriptEngine
  model: DebugTranscriptModelIdentity
  agentId: string
  startedAt: DebugTranscriptTimestampV1
  endedAt: DebugTranscriptTimestampV1 | null
  outcome: DebugTranscriptTurnOutcome | null
  systemPrompts: DebugTranscriptSystemPromptV1[]
  failures: DebugTranscriptFailureV1[]
}

export type DebugTranscriptCaptureStatus = {
  recorderDisabled: boolean
}

export type BeginDebugTranscriptTurnInput = {
  threadId: string
  traceId: string
  engine: DebugTranscriptEngine
  model: DebugTranscriptModelIdentity
  agentId: string
  userMessageId?: string
}

export type DebugTranscriptTurnV1 = {
  traceId: string
  source: DebugTranscriptTurnSource
  engine: DebugTranscriptEngine
  model: DebugTranscriptModelV1
  agentId: string | null
  userMessageId: string | null
  assistantMessageId: string | null
  userPrompt: DebugTranscriptTextEventV1
  systemPrompts: DebugTranscriptSystemPromptV1[]
  assistantOutput: DebugTranscriptTextEventV1 | null
  toolCalls: DebugTranscriptToolCallV1[]
  failures: DebugTranscriptFailureV1[]
  startedAt: DebugTranscriptTimestampV1 | null
  endedAt: DebugTranscriptTimestampV1 | null
  outcome: DebugTranscriptTurnOutcome | null
}

export type DebugTranscriptMessageMetadataV1 = {
  traceId: string
  engine: DebugTranscriptEngine | null
  modelId: string
  modelName: string
  provider: string
  agentId: string
}

export type DebugTranscriptPayloadV1 = {
  schemaVersion: 1
  capture: {
    capturedAt: string
    appVersion: string
    platform: string
    recorderDisabled: boolean
  }
  identity: {
    userId: string | null
    email: string | null
  }
  thread: {
    threadId: string
  }
  turns: DebugTranscriptTurnV1[]
}
