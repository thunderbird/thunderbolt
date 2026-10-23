/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import {
  compact,
  DEFAULT_COMPACTION_SETTINGS,
  estimateContextTokens,
  estimateTokens,
  prepareCompaction,
  type AgentHarness,
  type AgentMessage,
  type Session,
} from '@earendil-works/pi-agent-core'
import type { ReceiptLifecycle } from './confidential-model.ts'

/** Persisted with an app message, whose position supplies the transcript boundary. */
export type CompactionCheckpoint = {
  version: 1
  summary: string
  tokensBefore: number
  contextTokens: number
  retainedTail: AgentMessage[]
}

export type CompactionStatus = 'idle' | 'compacting' | 'compacted'

export type CompactionRequest = {
  signal?: AbortSignal
  instructions?: string
  overheadTokens?: number
  onStatus?: (status: CompactionStatus) => void
  /** Apply the caller's context policy before any history enters a durable summary. */
  transformMessage?: (message: AgentMessage) => AgentMessage
}

export type HarnessCompaction = {
  readonly revision: number
  compact: (request?: CompactionRequest) => Promise<CompactionCheckpoint>
  prepareRequest: (messages: AgentMessage[], request: CompactionRequest) => Promise<AgentMessage[]>
  checkpoint: () => Promise<CompactionCheckpoint | undefined>
  abort: () => void
}

/** Old provider usage describes the pre-compaction prompt, not the retained tail. */
const withoutUsage = (message: AgentMessage): AgentMessage =>
  message.role === 'assistant'
    ? {
        ...message,
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      }
    : message

/** Persist model-facing content, excluding image binaries and raw tool details used only by the live UI. */
const toSavedContextMessage = (message: AgentMessage): AgentMessage => {
  if (message.role !== 'user' && message.role !== 'toolResult' && message.role !== 'custom') {
    return message
  }
  if (typeof message.content === 'string') {
    return message
  }
  return {
    ...message,
    ...(message.role === 'toolResult' ? { details: undefined } : {}),
    content: message.content.map((part) =>
      part.type === 'image' ? { type: 'text', text: '[Image omitted from saved context]' } : part,
    ),
  }
}

/** Restore Pi's summary entry and real message entries so subsequent compactions can retain them. */
export const restoreCompaction = async (
  session: Session,
  checkpoint: Pick<CompactionCheckpoint, 'summary' | 'tokensBefore' | 'retainedTail'>,
): Promise<void> => {
  await session.appendCompaction(
    checkpoint.summary,
    undefined,
    checkpoint.tokensBefore,
    undefined,
    false,
    undefined,
    [],
  )
  for (const message of checkpoint.retainedTail) {
    await session.appendMessage(message)
  }
}

/**
 * Pi owns cutting, tool-pair preservation and summarization. The app owns the
 * 80% policy, cancellation and durable checkpoints. Using Pi's exported helpers
 * allows cancellation and model-sized retention; AgentHarness.compact in 0.82.1
 * hardcodes its settings and doesn't pass an abort signal to the summary request.
 */
export const createHarnessCompaction = (
  harness: AgentHarness,
  session: Session,
  restored?: CompactionCheckpoint,
  receipts?: ReceiptLifecycle,
): HarnessCompaction => {
  const state = {
    summary: restored?.summary,
    tokensBefore: restored?.tokensBefore ?? 0,
    controller: null as AbortController | null,
    overheadTokens: 0,
    revision: 0,
  }

  const checkpoint = async (): Promise<CompactionCheckpoint | undefined> => {
    if (state.summary === undefined) {
      return undefined
    }
    const { messages } = await session.buildContext()
    const retainedTail = messages.filter((message) => message.role !== 'compactionSummary').map(toSavedContextMessage)
    const estimate = estimateContextTokens(messages)
    return {
      version: 1,
      summary: state.summary,
      tokensBefore: state.tokensBefore,
      contextTokens: estimate.tokens + (estimate.lastUsageIndex === null ? state.overheadTokens : 0),
      retainedTail,
    }
  }

  const run = async (request: CompactionRequest = {}, manual = true): Promise<CompactionCheckpoint | undefined> => {
    if (state.controller) {
      throw new Error('Context compaction is already running')
    }
    request.signal?.throwIfAborted()
    const controller = new AbortController()
    state.controller = controller
    state.overheadTokens = request.overheadTokens ?? state.overheadTokens
    const signal = request.signal ? AbortSignal.any([controller.signal, request.signal]) : controller.signal
    let status: CompactionStatus = 'idle'
    request.onStatus?.('compacting')
    try {
      const model = harness.getModel()
      const settings = {
        ...DEFAULT_COMPACTION_SETTINGS,
        reserveTokens: Math.max(
          1,
          Math.min(DEFAULT_COMPACTION_SETTINGS.reserveTokens, Math.floor(model.contextWindow * 0.2)),
        ),
        keepRecentTokens: Math.min(DEFAULT_COMPACTION_SETTINGS.keepRecentTokens, Math.floor(model.contextWindow * 0.1)),
      }
      const branch = await session.getBranch()
      const prepared = prepareCompaction(branch, settings)
      if (!prepared.ok) {
        throw prepared.error
      }
      if (!prepared.value) {
        if (!manual) {
          return checkpoint()
        }
        throw new Error('Nothing to compact')
      }
      // Pi includes the message that crosses the retention budget. A single
      // large old message can therefore retain the whole history; try its
      // smallest safe tail before falling back to summarizing the whole turn.
      const cut =
        !manual && !prepared.value.messagesToSummarize.length && !prepared.value.turnPrefixMessages.length
          ? prepareCompaction(branch, { ...settings, keepRecentTokens: 0 })
          : prepared
      if (!cut.ok) {
        throw cut.error
      }
      const selected = cut.value ?? prepared.value
      const hasSummaryInput = selected.messagesToSummarize.length || selected.turnPrefixMessages.length
      const activeMessages = (await session.buildContext()).messages.filter(
        (message) => message.role !== 'compactionSummary',
      )
      // A fresh prompt has no older history to summarize. Leave the current
      // request intact; the caller checks whether it fits the model window.
      if (!manual && !hasSummaryInput && activeMessages.length <= 1) {
        return checkpoint()
      }
      // A small conversation can fit entirely inside Pi's retention budget.
      // Manual compaction must still summarize it instead of summarizing nothing.
      const preparation = hasSummaryInput
        ? selected
        : {
            ...selected,
            messagesToSummarize: activeMessages,
            turnPrefixMessages: [],
            retainedTail: [],
            isSplitTurn: false,
          }
      // Pi 0.82.1 omits customInstructions from its split-turn prefix request
      // and drops previousSummary when the cut has no preceding history.
      // Summarize the same cut together when either needs to be preserved.
      const guidedPreparation =
        preparation.isSplitTurn && (request.instructions?.trim() || preparation.previousSummary)
          ? {
              ...preparation,
              messagesToSummarize: [...preparation.messagesToSummarize, ...preparation.turnPrefixMessages],
              turnPrefixMessages: [],
              isSplitTurn: false,
            }
          : preparation
      const summarize = () =>
        compact(
          request.transformMessage
            ? {
                ...guidedPreparation,
                messagesToSummarize: guidedPreparation.messagesToSummarize.map(request.transformMessage),
                turnPrefixMessages: guidedPreparation.turnPrefixMessages.map(request.transformMessage),
                retainedTail: guidedPreparation.retainedTail.map(request.transformMessage),
              }
            : guidedPreparation,
          harness.models,
          model,
          request.instructions?.trim() || undefined,
          signal,
          harness.getThinkingLevel(),
        )
      const result = await (receipts ? receipts.withStandaloneRequests(summarize) : summarize())
      signal.throwIfAborted()
      if (!result.ok) {
        throw result.error
      }
      const value = result.value
      if (!value.summary.trim()) {
        throw new Error('Compaction returned an empty summary')
      }
      const retainedTail = (value.retainedTail ?? []).map(withoutUsage)
      // Keep original entries for history, but materialize the retained tail
      // after the boundary. Pi can then compact again even after a restore.
      await restoreCompaction(session, {
        summary: value.summary,
        tokensBefore: value.tokensBefore,
        retainedTail,
      })
      state.summary = value.summary
      state.tokensBefore = value.tokensBefore
      state.revision++
      const nextCheckpoint = (await checkpoint())!
      status = 'compacted'
      return nextCheckpoint
    } finally {
      state.controller = null
      request.onStatus?.(status)
    }
  }

  return {
    get revision() {
      return state.revision
    },
    compact: async (request) => (await run(request))!,
    checkpoint,
    abort: () => state.controller?.abort(),
    prepareRequest: async (messages, request) => {
      request.signal?.throwIfAborted()
      const window = harness.getModel().contextWindow
      const estimate = estimateContextTokens(messages)
      // Provider usage already includes the system prompt and tool schemas.
      const tokens = estimate.tokens + (estimate.lastUsageIndex === null ? (request.overheadTokens ?? 0) : 0)
      if (!(window > 0) || tokens < window * 0.8) {
        return messages
      }
      await run(request, false)
      const context = await session.buildContext()
      // A huge prompt or tool result can remain too large after summarization.
      // Fail once, visibly, rather than repeatedly charging for futile summaries.
      const remaining = context.messages.reduce((total, message) => total + estimateTokens(message), 0)
      if (remaining + (request.overheadTokens ?? 0) >= window) {
        throw new Error(
          'Context length still exceeds the model window after compaction. Reduce the input or choose a larger model.',
        )
      }
      return context.messages
    },
  }
}
