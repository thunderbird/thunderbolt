/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { DynamicToolUIPart, UIMessageChunk } from 'ai'
import type { CloudRun } from '@shared/cloud-agent/contracts'
import type { ThunderboltUIMessage, UIMessageMetadata } from '@/types'
import type { CloudConversationView } from './client'
import { isCloudRunActive } from './protocol'

type ProjectedMessage = CloudConversationView['decryptedMessages'][number]

/** Durable run identity is shared by live streams and later history hydration. */
export const cloudAssistantMessageId = (runId: string): string => `cloud-run:${runId}`

/** Keep all records for one turn together, even when later prompts are queued before its answer. */
export const cloudRunRecords = (view: CloudConversationView, runId: string): ProjectedMessage[] =>
  view.decryptedMessages
    .filter(({ record }) => record.runId === runId)
    .toSorted((a, b) => a.record.sequence - b.record.sequence)

/** Attach authoritative provenance and a stable ordering key without copying encrypted runtime state. */
export const cloudRunMetadata = (
  view: CloudConversationView,
  run: CloudRun,
  recordIds = cloudRunRecords(view, run.id)
    .filter(({ content }) => content.role !== 'user')
    .map(({ record }) => record.id),
): UIMessageMetadata => {
  const records = cloudRunRecords(view, run.id)
  const first = records.find(({ content }) => content.role === 'user') ?? records[0]
  return {
    cloud: {
      agentId: view.conversation.agentId,
      conversationId: view.conversation.id,
      runId: run.id,
      commandId: run.commandId,
      status: run.status,
      recordIds,
      sequence: (first?.record.sequence ?? view.runs.indexOf(run) + 1) * 2 + 1,
      artifactIds: [...new Set(records.flatMap(({ content }) => content.artifactIds ?? []))],
    },
  }
}

const toolOutput = (text: string): unknown => {
  try {
    return JSON.parse(text) as unknown
  } catch {
    return text
  }
}

/** Convert one immutable record to SDK events; native Pi call IDs keep parallel results attached correctly. */
export const cloudRecordChunks = ({ record, content }: ProjectedMessage, knownTools: Set<string>): UIMessageChunk[] => {
  if (content.role === 'user') {
    return []
  }
  if (content.role === 'tool') {
    const id = content.toolCallId ?? record.id
    const input: UIMessageChunk[] = knownTools.has(id)
      ? []
      : [
          {
            type: 'tool-input-available',
            toolCallId: id,
            toolName: content.toolName ?? 'tool',
            input: {},
            dynamic: true,
            providerExecuted: true,
          },
        ]
    knownTools.add(id)
    return [
      ...input,
      content.toolError
        ? { type: 'tool-output-error', toolCallId: id, errorText: content.text, dynamic: true, providerExecuted: true }
        : {
            type: 'tool-output-available',
            toolCallId: id,
            output: toolOutput(content.text),
            dynamic: true,
            providerExecuted: true,
          },
    ]
  }
  const chunks: UIMessageChunk[] = content.text
    ? [
        { type: 'text-start', id: record.id },
        { type: 'text-delta', id: record.id, delta: content.text },
        { type: 'text-end', id: record.id },
      ]
    : []
  for (const call of content.toolCalls ?? []) {
    knownTools.add(call.id)
    chunks.push({
      type: 'tool-input-available',
      toolCallId: call.id,
      toolName: call.name,
      input: call.arguments,
      dynamic: true,
      providerExecuted: true,
    })
  }
  return chunks
}

/** Derive ordinary chat messages from the server projection; no client-generated reply or run replay is involved. */
export const cloudConversationMessages = (view: CloudConversationView): ThunderboltUIMessage[] =>
  view.runs.flatMap((run) => {
    const records = cloudRunRecords(view, run.id)
    const input = records.find(({ content }) => content.role === 'user')
    const parts: ThunderboltUIMessage['parts'] = []
    const tools = new Map<string, number>()
    for (const { record, content } of records) {
      if (content.role === 'user') {
        continue
      }
      if (content.role === 'tool') {
        const toolCallId = content.toolCallId ?? record.id
        const existing = tools.get(toolCallId)
        const old = existing === undefined ? undefined : parts[existing]
        const input = old?.type === 'dynamic-tool' ? old.input : {}
        const part: DynamicToolUIPart = {
          type: 'dynamic-tool',
          toolCallId,
          toolName: content.toolName ?? 'tool',
          providerExecuted: true,
          ...(content.toolError
            ? { state: 'output-error', input, errorText: content.text }
            : { state: 'output-available', input, output: toolOutput(content.text) }),
        }
        if (existing === undefined) {
          tools.set(toolCallId, parts.length)
          parts.push(part)
        } else {
          parts[existing] = part
        }
        continue
      }
      if (content.text) {
        parts.push({ type: 'text', text: content.text, state: 'done' })
      }
      for (const call of content.toolCalls ?? []) {
        tools.set(call.id, parts.length)
        parts.push({
          type: 'dynamic-tool',
          toolCallId: call.id,
          toolName: call.name,
          input: call.arguments,
          state: 'input-available',
          providerExecuted: true,
        })
      }
    }
    const metadata = cloudRunMetadata(view, run)
    const messages: ThunderboltUIMessage[] = input
      ? [
          {
            id: run.commandId,
            role: 'user',
            parts: [{ type: 'text', text: input.content.text }],
            metadata: {
              cloud: {
                ...metadata.cloud!,
                sequence: metadata.cloud!.sequence - 1,
                recordIds: [input.record.id],
                artifactIds: [],
              },
            },
          },
        ]
      : []
    if (parts.length || isCloudRunActive(run.status) || ['failed', 'blocked', 'uncertain'].includes(run.status)) {
      messages.push({ id: cloudAssistantMessageId(run.id), role: 'assistant', parts, metadata })
    }
    return messages
  })
