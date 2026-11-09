/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import {
  generateSummary,
  CompactionError,
  DEFAULT_COMPACTION_SETTINGS,
  estimateContextTokens,
  estimateTokens,
  prepareCompaction,
  type AgentHarness,
  type AgentMessage,
  type BranchSummaryDetails,
  type Session,
} from '@earendil-works/pi-agent-core'

/** Persisted with an app message, whose position supplies the transcript boundary. */
export type CompactionCheckpoint = {
  version: 1
  summary: string
  tokensBefore: number
  contextTokens: number
  retainedTail: AgentMessage[]
  /** Structured inventory survives subsequent summaries without relying on model output. */
  files?: BranchSummaryDetails
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

/** Target 10% of a model's window, capped by Pi's normal retention budget. */
const recentContextBudget = (contextWindow: number): number =>
  Math.min(DEFAULT_COMPACTION_SETTINGS.keepRecentTokens, Math.floor(contextWindow * 0.1))

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

/** Include the whole manual fallback range, which Pi's retained-tail cut does not summarize. */
const includeFileOperations = (
  messages: AgentMessage[],
  fileOps: { read: Set<string>; written: Set<string>; edited: Set<string> },
): void => {
  for (const message of messages) {
    if (message.role !== 'assistant') {
      continue
    }
    for (const block of message.content) {
      if (block.type !== 'toolCall' || typeof block.arguments.path !== 'string') {
        continue
      }
      if (block.name === 'read') {
        fileOps.read.add(block.arguments.path)
      }
      if (block.name === 'write') {
        fileOps.written.add(block.arguments.path)
      }
      if (block.name === 'edit') {
        fileOps.edited.add(block.arguments.path)
      }
    }
  }
}

/** Preserve Pi's exact file inventory separately from the model-generated summary. */
const savedFileOperations = (fileOps: {
  read: Set<string>
  written: Set<string>
  edited: Set<string>
}): BranchSummaryDetails => {
  const modified = new Set([...fileOps.written, ...fileOps.edited])
  return {
    readFiles: [...fileOps.read].filter((path) => !modified.has(path)).sort(),
    modifiedFiles: [...modified].sort(),
  }
}

/** Render the deterministic inventory appended after validating the model's summary. */
const fileOperationsSummary = (files: BranchSummaryDetails): string =>
  (
    [
      ['read-files', files.readFiles],
      ['modified-files', files.modifiedFiles],
    ] as const
  )
    .filter(([, paths]) => paths.length > 0)
    .map(([tag, paths]) => `<${tag}>\n${paths.join('\n')}\n</${tag}>`)
    .join('\n\n')

/** Restore Pi's summary entry and real message entries so subsequent compactions can retain them. */
export const restoreCompaction = async (
  session: Session,
  checkpoint: Pick<CompactionCheckpoint, 'summary' | 'tokensBefore' | 'retainedTail' | 'files'>,
): Promise<void> => {
  await session.appendCompaction(
    checkpoint.summary,
    undefined,
    checkpoint.tokensBefore,
    checkpoint.files,
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
): HarnessCompaction => {
  const state = {
    summary: restored?.summary,
    files: restored?.files,
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
      files: state.files,
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
    try {
      request.onStatus?.('compacting')
      const model = harness.getModel()
      const settings = {
        ...DEFAULT_COMPACTION_SETTINGS,
        reserveTokens: Math.max(
          1,
          Math.min(DEFAULT_COMPACTION_SETTINGS.reserveTokens, Math.floor(model.contextWindow * 0.2)),
        ),
        keepRecentTokens: recentContextBudget(model.contextWindow),
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
      // Summarize the cut in one request, including any split-turn prefix. Pi's
      // separate prefix request loses custom instructions and previous summaries,
      // and its separator can disguise an empty model response as a valid summary.
      // A short manual conversation can fit entirely in the retention budget;
      // summarize all of it rather than sending an empty summary request.
      const summaryMessages = hasSummaryInput
        ? [...selected.messagesToSummarize, ...selected.turnPrefixMessages]
        : activeMessages
      const tail = hasSummaryInput ? selected.retainedTail : []
      const result = await generateSummary(
        request.transformMessage ? summaryMessages.map(request.transformMessage) : summaryMessages,
        harness.models,
        model,
        settings.reserveTokens,
        signal,
        request.instructions?.trim() || undefined,
        selected.previousSummary,
        harness.getThinkingLevel(),
      )
      signal.throwIfAborted()
      if (!result.ok) {
        throw result.error
      }
      if (!result.value.trim()) {
        throw new CompactionError('summarization_failed', 'Compaction returned an empty summary')
      }
      if (!hasSummaryInput) {
        includeFileOperations(summaryMessages, selected.fileOps)
      }
      const files = savedFileOperations(selected.fileOps)
      const summary = [result.value, fileOperationsSummary(files)].filter(Boolean).join('\n\n')
      const retainedTail = (request.transformMessage ? tail.map(request.transformMessage) : tail).map(withoutUsage)
      // Keep original entries for history, but materialize the retained tail
      // after the boundary. Pi can then compact again even after a restore.
      await restoreCompaction(session, {
        summary,
        files,
        tokensBefore: selected.tokensBefore,
        retainedTail,
      })
      state.summary = summary
      state.files = files
      state.tokensBefore = selected.tokensBefore
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
      // Prompt and tool overhead cannot be compacted. Preserve already-small
      // history instead of paying for another summary on every tool step.
      const historyTokens = messages.reduce((total, message) => total + estimateTokens(message), 0)
      if (tokens < window && historyTokens <= recentContextBudget(window)) {
        return messages
      }
      try {
        await run(request, false)
      } catch (error) {
        request.signal?.throwIfAborted()
        if (!(error instanceof CompactionError) || error.code !== 'summarization_failed' || tokens >= window) {
          throw error
        }
        // Automatic compaction is proactive. A summary outage must not block a
        // prompt that still fits; manual compaction continues to report failures.
        console.warn('Automatic context compaction failed; keeping the current context', error)
        return messages
      }
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
