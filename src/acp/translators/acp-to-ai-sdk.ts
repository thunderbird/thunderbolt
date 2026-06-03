/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Translator: ACP `SessionNotification.update` → AI SDK v5 UI message stream.
 *
 * The output `ReadableStream<Uint8Array>` matches what
 * `createUIMessageStreamResponse` produces: each chunk is a UTF-8 encoded
 * `data: <json>\n\n` line. AI SDK's `DefaultChatTransport` consumes this
 * format directly from the `Response.body` returned by an adapter's `fetch`.
 *
 * Mapping:
 *   agent_message_chunk (text)      → text-start (once) → text-delta…   → text-end (on finish)
 *   agent_message_chunk (reasoning) → reasoning-start … → reasoning-delta … (rare)
 *   agent_thought_chunk             → reasoning-start (once) → reasoning-delta … → reasoning-end
 *   tool_call                       → tool-input-start + tool-input-available
 *   tool_call_update (in_progress)  → buffered (no emit)
 *   tool_call_update (completed)    → tool-output-available
 *   tool_call_update (failed)       → tool-output-error
 *   plan, available_commands_update → ignored in MVP
 *
 * Text-delta throttling: deltas for a given text-message id are coalesced and
 * flushed at most every `textDeltaThrottleMs` (default 200ms). On stream end /
 * finish, any buffered delta is flushed before emitting `finish`.
 */

import type { SessionConfigOption, SessionNotification, ToolCallStatus } from '@agentclientprotocol/sdk'
import type { HaystackDocumentMeta, HaystackReferenceMeta } from '@/types'
import type { AiSdkChunk } from '../types'

const sseDataPrefix = 'data: '
const sseDataSuffix = '\n\n'
const textDeltaThrottleMsDefault = 200

// Key the reasoning duration to the first reasoning part in a group. The UI's
// `groupMessageParts` labels reasoning items `reasoning-<counter>` (0-based per
// message), and this translator emits a single reasoning stream, so its
// duration always lands on `reasoning-0`.
const reasoningDurationKey = 'reasoning-0'

const encoder = new TextEncoder()

const encodeChunk = (chunk: AiSdkChunk): Uint8Array =>
  encoder.encode(`${sseDataPrefix}${JSON.stringify(chunk)}${sseDataSuffix}`)

const encodeDone = (): Uint8Array => encoder.encode(`${sseDataPrefix}[DONE]${sseDataSuffix}`)

/** Per-message delta accumulator. Buffers deltas + emits at most once per
 *  `throttleMs`. `kind` controls whether emits are `text-delta` or
 *  `reasoning-delta` so a single helper handles both streams. */
type DeltaThrottle = {
  kind: 'text' | 'reasoning'
  buffer: string
  timer: ReturnType<typeof setTimeout> | null
  emit: (chunk: AiSdkChunk) => void
  id: string
}

const createThrottle = (kind: 'text' | 'reasoning', id: string, emit: (chunk: AiSdkChunk) => void): DeltaThrottle => ({
  kind,
  buffer: '',
  timer: null,
  emit,
  id,
})

const emitDelta = (t: DeltaThrottle, delta: string): void => {
  if (t.kind === 'text') {
    t.emit({ type: 'text-delta', id: t.id, delta })
  } else {
    t.emit({ type: 'reasoning-delta', id: t.id, delta })
  }
}

const flushThrottle = (t: DeltaThrottle): void => {
  if (t.timer) {
    clearTimeout(t.timer)
    t.timer = null
  }
  if (t.buffer.length === 0) {
    return
  }
  const delta = t.buffer
  t.buffer = ''
  emitDelta(t, delta)
}

const pushThrottled = (t: DeltaThrottle, delta: string, throttleMs: number): void => {
  t.buffer += delta
  if (t.timer) {
    return
  }
  t.timer = setTimeout(() => {
    t.timer = null
    if (t.buffer.length > 0) {
      const out = t.buffer
      t.buffer = ''
      emitDelta(t, out)
    }
  }, throttleMs)
}

/** Side-channel events the translator surfaces for ACP `sessionUpdate`s that
 *  don't map to AI SDK chunks (mode change, config option change, etc.).
 *  Consumers wire this to the chat-store so the UI reacts to server-driven
 *  state. Server is the source of truth; user-initiated changes flow through
 *  their normal store actions and would simply be confirmed by the next emit. */
export type SessionSideEffect =
  | { type: 'mode_changed'; modeId: string }
  | { type: 'config_options_changed'; options: SessionConfigOption[] }

export type SessionSideEffectSink = (effect: SessionSideEffect) => void

export type TranslateOptions = {
  /** Stable id for the assistant text message. Defaults to `'acp-text-0'`. */
  textMessageId?: string
  /** Stable id for the assistant reasoning message. Defaults to `'acp-reasoning-0'`. */
  reasoningMessageId?: string
  /** Override throttle for tests. */
  textDeltaThrottleMs?: number
  /** Callback for non-stream session updates (mode change, config option
   *  change). Omit to keep the prior behavior of silently ignoring them. */
  onSideEffect?: SessionSideEffectSink
  /** Epoch-millis clock used to measure per-action durations. Defaults to
   *  `Date.now`. Inject a fake in tests so durations are deterministic. */
  now?: () => number
}

/** Translation state for a single ACP prompt turn. Reused across many calls
 *  to `handle(notification)`; the consumer drives the lifecycle by calling
 *  `start()`, then `handle(...)` for each notification, then `finish()`. */
export type Translator = {
  /** Emit `start` + `start-step`. Call once at the beginning of a prompt turn. */
  start: () => void
  /** Translate one ACP notification and emit zero or more AI SDK chunks. */
  handle: (notification: SessionNotification) => void
  /** Ingest a free-form `_meta` object — typically the `PromptResponse._meta`
   *  surfaced by the SDK's `connection.prompt(...)` return. Same shape as the
   *  notification-level `_meta`; merges into the running haystack metadata
   *  and emits a `message-metadata` chunk if any haystack keys are present. */
  ingestMeta: (meta: { [key: string]: unknown } | null | undefined) => void
  /** Flush any buffered deltas, close any open text/reasoning parts, and emit
   *  `finish-step` + `finish`. Call once when the ACP prompt resolves. */
  finish: () => void
  /** Emit a terminal `error` chunk. Use this when the transport fails. */
  error: (message: string) => void
}

/** Build a translator that writes AI SDK chunks into the provided `emit`
 *  callback. Splitting state from sinking lets callers buffer into either a
 *  `ReadableStreamController` (production) or an array (tests). */
export const createTranslator = (emit: (chunk: AiSdkChunk) => void, options: TranslateOptions = {}): Translator => {
  const textId = options.textMessageId ?? 'acp-text-0'
  const reasoningId = options.reasoningMessageId ?? 'acp-reasoning-0'
  const throttleMs = options.textDeltaThrottleMs ?? textDeltaThrottleMsDefault
  const sideEffect = options.onSideEffect ?? (() => {})
  const now = options.now ?? Date.now

  const textThrottle = createThrottle('text', textId, emit)
  const reasoningThrottle = createThrottle('reasoning', reasoningId, emit)
  let textStarted = false
  let reasoningStarted = false
  // Status the tool call was last seen in. Used so a `completed`/`failed` update
  // emits the right output chunk even if its raw output sneaks in via a prior
  // `in_progress` update.
  const toolStatus = new Map<string, ToolCallStatus>()
  // Per-action start timestamps used to compute durations the UI renders.
  // Tool calls key by `toolCallId` (the same id `groupMessageParts` assigns to
  // a tool group item); reasoning keys by `reasoningDurationKey` (the first
  // reasoning part in a group — the only reasoning stream this translator
  // emits — which `groupMessageParts` labels `reasoning-0`).
  const toolStartTimes = new Map<string, number>()
  let reasoningStartTime: number | null = null
  let reasoningDurationEmitted = false

  // Emit a single duration into the running `reasoningTime` map. The AI SDK
  // deep-merges successive `message-metadata` chunks, so one entry per action
  // accumulates rather than overwrites — mirroring `createMessageMetadata`.
  const emitDuration = (partId: string, elapsedMs: number): void => {
    emit({ type: 'message-metadata', messageMetadata: { reasoningTime: { [partId]: elapsedMs } } })
  }

  // Reasoning truly ends when text generation begins (the reasoning stream stays
  // open until then — see `message-metadata.ts`). Emit the reasoning duration at
  // that boundary, or as a fallback when the turn finishes with no text.
  const emitReasoningDuration = (): void => {
    if (reasoningDurationEmitted || reasoningStartTime === null) {
      return
    }
    reasoningDurationEmitted = true
    emitDuration(reasoningDurationKey, now() - reasoningStartTime)
  }
  // Haystack metadata accumulators. Backend emits these in `_meta` on
  // `agent_message_chunk` updates; references keyed by position so later chunks
  // override earlier ones for the same marker.
  const haystackReferencesByPosition = new Map<number, HaystackReferenceMeta>()
  const haystackDocumentsById = new Map<string, HaystackDocumentMeta>()

  const ingestHaystackMeta = (meta: { [key: string]: unknown } | null | undefined): void => {
    if (!meta) {
      return
    }
    const refs = meta.haystackReferences
    if (Array.isArray(refs)) {
      for (const ref of refs as HaystackReferenceMeta[]) {
        haystackReferencesByPosition.set(ref.position, ref)
      }
    }
    const docs = meta.haystackDocuments
    if (Array.isArray(docs)) {
      for (const doc of docs as HaystackDocumentMeta[]) {
        haystackDocumentsById.set(doc.id, doc)
      }
    }
    if (Array.isArray(refs) || Array.isArray(docs)) {
      emitHaystackMetadata()
    }
  }

  const emitHaystackMetadata = (): void => {
    const messageMetadata: Record<string, unknown> = {}
    if (haystackReferencesByPosition.size > 0) {
      messageMetadata.haystackReferences = Array.from(haystackReferencesByPosition.values()).sort(
        (a, b) => a.position - b.position,
      )
    }
    if (haystackDocumentsById.size > 0) {
      messageMetadata.haystackDocuments = Array.from(haystackDocumentsById.values())
    }
    if (Object.keys(messageMetadata).length === 0) {
      return
    }
    emit({ type: 'message-metadata', messageMetadata })
  }

  const ensureTextStarted = (): void => {
    if (textStarted) {
      return
    }
    textStarted = true
    emitReasoningDuration()
    emit({ type: 'text-start', id: textId })
  }

  const ensureReasoningStarted = (): void => {
    if (reasoningStarted) {
      return
    }
    reasoningStarted = true
    reasoningStartTime = now()
    emit({ type: 'reasoning-start', id: reasoningId })
  }

  const handle = (notification: SessionNotification): void => {
    const update = notification.update
    // ACP `_meta` lives on the SessionNotification itself, but agents may also
    // attach it to the inner update (per ACP spec — both `SessionNotification`
    // and `ContentChunk` declare an optional `_meta`). Ingest from both so the
    // pipeline works regardless of where the agent placed the metadata.
    ingestHaystackMeta(notification._meta)
    switch (update.sessionUpdate) {
      case 'agent_message_chunk': {
        ingestHaystackMeta(update._meta)
        const block = update.content
        if (block.type !== 'text') {
          return
        }
        ensureTextStarted()
        pushThrottled(textThrottle, block.text, throttleMs)
        return
      }
      case 'agent_thought_chunk': {
        const block = update.content
        if (block.type !== 'text') {
          return
        }
        ensureReasoningStarted()
        pushThrottled(reasoningThrottle, block.text, throttleMs)
        return
      }
      case 'tool_call': {
        toolStatus.set(update.toolCallId, update.status ?? 'pending')
        toolStartTimes.set(update.toolCallId, now())
        emit({
          type: 'tool-input-start',
          toolCallId: update.toolCallId,
          toolName: update.title,
          title: update.title,
        })
        emit({
          type: 'tool-input-available',
          toolCallId: update.toolCallId,
          toolName: update.title,
          input: update.rawInput ?? {},
          title: update.title,
        })
        return
      }
      case 'tool_call_update': {
        const status = update.status ?? toolStatus.get(update.toolCallId) ?? 'in_progress'
        toolStatus.set(update.toolCallId, status)
        if (status === 'in_progress' || status === 'pending') {
          return
        }
        if (status === 'failed') {
          emit({
            type: 'tool-output-error',
            toolCallId: update.toolCallId,
            errorText: typeof update.rawOutput === 'string' ? update.rawOutput : JSON.stringify(update.rawOutput ?? {}),
          })
        } else {
          // completed
          emit({
            type: 'tool-output-available',
            toolCallId: update.toolCallId,
            output: update.rawOutput ?? update.content ?? {},
          })
        }
        const startedAt = toolStartTimes.get(update.toolCallId)
        if (startedAt !== undefined) {
          toolStartTimes.delete(update.toolCallId)
          emitDuration(update.toolCallId, now() - startedAt)
        }
        return
      }
      case 'current_mode_update': {
        sideEffect({ type: 'mode_changed', modeId: update.currentModeId })
        return
      }
      case 'config_option_update': {
        sideEffect({ type: 'config_options_changed', options: update.configOptions })
        return
      }
      // Ignored in MVP.
      case 'plan':
      case 'available_commands_update':
      case 'session_info_update':
      case 'usage_update':
      case 'user_message_chunk':
        return
    }
  }

  const start = (): void => {
    emit({ type: 'start' })
    emit({ type: 'start-step' })
  }

  const finish = (): void => {
    flushThrottle(textThrottle)
    flushThrottle(reasoningThrottle)
    if (reasoningStarted) {
      // Covers reasoning-only turns where no text-start boundary fired.
      emitReasoningDuration()
      emit({ type: 'reasoning-end', id: reasoningId })
    }
    if (textStarted) {
      emit({ type: 'text-end', id: textId })
    }
    emit({ type: 'finish-step' })
    emit({ type: 'finish' })
  }

  const error = (message: string): void => {
    flushThrottle(textThrottle)
    flushThrottle(reasoningThrottle)
    emit({ type: 'error', errorText: message })
  }

  return { start, handle, ingestMeta: ingestHaystackMeta, finish, error }
}

/** Convenience: build a `ReadableStream<Uint8Array>` of SSE-formatted chunks
 *  from a `Translator`. Returns the stream plus an `emit` sink the caller
 *  wires the translator into. The stream closes when `close()` is called. */
export const createTranslatorStream = (
  options: TranslateOptions = {},
): { body: ReadableStream<Uint8Array>; translator: Translator; close: () => void } => {
  let controller: ReadableStreamDefaultController<Uint8Array>
  let closed = false

  const body = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c
    },
  })

  const emit = (chunk: AiSdkChunk): void => {
    if (closed) {
      return
    }
    controller.enqueue(encodeChunk(chunk))
  }

  const translator = createTranslator(emit, options)

  const close = (): void => {
    if (closed) {
      return
    }
    closed = true
    controller.enqueue(encodeDone())
    controller.close()
  }

  return { body, translator, close }
}
