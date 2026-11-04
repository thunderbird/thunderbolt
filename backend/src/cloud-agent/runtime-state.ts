/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { z } from 'zod'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { defineDoc, defineDocFamily, ToolResultEntry, type EntryRecord, type Harness } from '@earendil-works/pi-durable'
import type { AssistantMessage } from '@earendil-works/pi-ai'
import type { TranscriptContext } from '@earendil-works/pi-ai/utils/transcript'
import type { CloudAgentConfig, CloudMessageContent } from '@shared/cloud-agent/contracts'
import { encryptScopedBytes, decryptScopedBytes, indexScopedValue } from '@shared/cloud-agent/crypto'
import type { StorageCodec } from './storage'
import type { CloudModelCredentials } from './models'
import { ciphertextSchema } from './input'
import { CloudError } from './errors'

// Change only alongside an explicit compatibility decision or migration.
export const runtimeEngineVersion = 'pi-durable:1.3.0/thunderbolt:1'
export const RuntimeVersion = defineDoc<{ engine: string }>({
  kind: 'thunderbolt.runtime-version',
  version: 1,
  scope: 'session',
  initial: () => ({ engine: runtimeEngineVersion }),
})

export const ConversationBinding = defineDocFamily<{ piId: number | null }, null>({
  kind: 'thunderbolt.conversation',
  version: 1,
  scope: 'session',
  family: true,
  initial: () => ({ piId: null }),
})
export const RunBudget = defineDocFamily<
  { requests: number; chargedMicros: number; pending: Record<string, number> },
  null
>({
  kind: 'thunderbolt.budget',
  version: 1,
  scope: 'session',
  family: true,
  initial: () => ({ requests: 0, chargedMicros: 0, pending: {} }),
})

/** Bind every runtime ciphertext and private index to one explicitly granted agent key. */
export const createRuntimeCodec = (
  key: CryptoKey,
  ownerId: string,
  agentId: string,
  keyEpoch: number,
): StorageCodec => {
  const context = { ownerId, scopeId: `agent:${agentId}`, keyEpoch, purpose: 'runtime-state' }
  return {
    encode: async (plaintext, recordId) =>
      JSON.stringify(await encryptScopedBytes(new TextEncoder().encode(plaintext), key, { ...context, recordId })),
    decode: async (ciphertext, recordId) =>
      new TextDecoder().decode(
        await decryptScopedBytes(ciphertextSchema.parse(JSON.parse(ciphertext)), key, { ...context, recordId }),
      ),
    index: (value) => indexScopedValue(value, key, { ...context, purpose: 'runtime-index' }),
  }
}

/** Reserve the worst-case request cost before any network dispatch; unresolved attempts retain their reservation. */
export const reserveModelRequest = async (
  harness: Harness,
  runId: string,
  config: CloudAgentConfig & { model: NonNullable<CloudAgentConfig['model']> },
  credentials: CloudModelCredentials,
  transcript: TranscriptContext,
): Promise<number> => {
  const inputUpperBound = Math.min(
    config.model.contextWindow,
    new TextEncoder().encode(JSON.stringify(transcript)).length + 4096,
  )
  const reservedMicros = Math.ceil(
    inputUpperBound * Math.max(credentials.cost.input, credentials.cost.cacheRead, credentials.cost.cacheWrite) +
      config.model.maxOutputTokens * credentials.cost.output,
  )
  return harness.commit(async (tx) => {
    const budget = await tx.doc(RunBudget, runId, null)
    if (config.maxSteps !== null && budget.requests >= config.maxSteps) {
      throw new CloudError(409, 'step_limit_reached')
    }
    if (
      config.maxRunCostUsd !== null &&
      budget.chargedMicros + reservedMicros > Math.floor(config.maxRunCostUsd * 1_000_000)
    ) {
      throw new CloudError(409, 'run_budget_exceeded')
    }
    budget.requests += 1
    budget.chargedMicros += reservedMicros
    budget.pending[String(budget.requests)] = reservedMicros
    return budget.requests
  }, BACKGROUND_CONTEXT)
}

/** Settle reported usage once. Missing usage and interrupted requests keep their conservative charge. */
export const settleModelRequest = async (
  harness: Harness,
  runId: string,
  request: number,
  response: AssistantMessage,
): Promise<void> => {
  await harness.commit(async (tx) => {
    const budget = await tx.doc(RunBudget, runId, null)
    const reserved = budget.pending[String(request)]
    if (reserved === undefined) {
      return
    }
    const reported =
      response.usage.totalTokens > 0 && Number.isFinite(response.usage.cost.total) && response.usage.cost.total >= 0
    budget.chargedMicros += reported ? Math.ceil(response.usage.cost.total * 1_000_000) - reserved : 0
    delete budget.pending[String(request)]
  }, BACKGROUND_CONTEXT)
}

/** An unsafe tool that lost its result cannot safely be repeated or treated as a normal failure. */
export const isUncertainToolResult = (entry: EntryRecord): boolean =>
  ToolResultEntry.is(entry) &&
  entry.data.diagnostics.some(
    (diagnostic) => diagnostic.code === 'interrupted' || diagnostic.code === 'outcome_uncertain',
  )

const artifactResult = z.object({ artifactId: z.string().uuid() })

/** Only built-in artifact results identify attachments; arbitrary external tool JSON does not. */
const resultArtifactIds = (toolName: string, text: string): string[] => {
  if (!['create_artifact', 'update_artifact', 'read_artifact'].includes(toolName)) {
    return []
  }
  try {
    const parsed = artifactResult.safeParse(JSON.parse(text))
    return parsed.success ? [parsed.data.artifactId] : []
  } catch {
    return []
  }
}

/** Project only immutable messages, using Pi entry identity as the client-visible deduplication key. */
export const projectEntry = (entry: EntryRecord): { logicalId: string; content: CloudMessageContent }[] => {
  if (entry.kind === 'pi.compaction' || entry.kind === 'pi.reset') {
    return []
  }
  return (entry.model ?? []).flatMap((message, index) => {
    if (message.role === 'system') {
      return []
    }
    const text =
      typeof message.content === 'string'
        ? message.content
        : message.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('\n')
    const toolCalls =
      message.role === 'assistant'
        ? message.content.flatMap((block) =>
            block.type === 'toolCall' ? [{ id: block.id, name: block.name, arguments: block.arguments }] : [],
          )
        : []
    if (!text && toolCalls.length === 0 && message.role !== 'toolResult') {
      return []
    }
    return [
      {
        logicalId: `pi:${entry.id}:${index}`,
        content: {
          role: message.role === 'toolResult' ? 'tool' : message.role,
          text,
          ...(toolCalls.length ? { toolCalls } : {}),
          ...(message.role === 'toolResult'
            ? {
                toolName: message.toolName,
                toolCallId: message.toolCallId,
                toolError: message.isError,
                ...(!message.isError ? { artifactIds: resultArtifactIds(message.toolName, text) } : {}),
              }
            : {}),
        },
      },
    ]
  })
}
