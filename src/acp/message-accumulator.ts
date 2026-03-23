import type { SessionNotification } from '@agentclientprotocol/sdk'
import type { HaystackDocumentMeta, HaystackReferenceMeta, ThunderboltUIMessage, UIMessageMetadata } from '@/types'
import { v7 as uuidv7 } from 'uuid'

type SessionUpdate = SessionNotification['update']

type ToolCallState = {
  toolCallId: string
  toolName: string
  status: 'pending' | 'in_progress' | 'completed' | 'failed'
  args: Record<string, unknown>
  result: unknown
}

/**
 * Accumulates ACP streaming updates into a ThunderboltUIMessage.
 * Each prompt creates a new accumulator for the assistant response.
 */
export const createMessageAccumulator = (messageId?: string) => {
  const id = messageId ?? uuidv7()
  let textContent = ''
  let reasoningContent = ''
  const toolCalls = new Map<string, ToolCallState>()

  // Haystack metadata from _meta
  let haystackReferences: HaystackReferenceMeta[] | undefined
  let haystackDocuments: HaystackDocumentMeta[] | undefined
  let isDocumentSearch = false

  const buildMessage = (): ThunderboltUIMessage => {
    const parts: ThunderboltUIMessage['parts'] = []

    // Add reasoning part if present
    if (reasoningContent.length > 0) {
      parts.push({
        type: 'reasoning',
        text: reasoningContent,
        providerMetadata: {},
      })
    }

    // Add tool call parts
    for (const tc of toolCalls.values()) {
      if (tc.status === 'completed' || tc.status === 'failed') {
        parts.push({
          type: `tool-${tc.toolName}` as `tool-${string}`,
          toolCallId: tc.toolCallId,
          state: 'result' as const,
          input: tc.args,
          output: tc.result,
        } as unknown as ThunderboltUIMessage['parts'][number])
      } else {
        parts.push({
          type: `tool-${tc.toolName}` as `tool-${string}`,
          toolCallId: tc.toolCallId,
          state: 'call' as const,
          input: tc.args,
        } as unknown as ThunderboltUIMessage['parts'][number])
      }
    }

    // Add text part
    if (textContent.length > 0) {
      parts.push({
        type: 'text',
        text: textContent,
      })
    }

    // If no parts at all, add empty text
    if (parts.length === 0) {
      parts.push({ type: 'text', text: '' })
    }

    // Build metadata
    const metadata: UIMessageMetadata = {}
    if (haystackReferences) {
      metadata.haystackReferences = haystackReferences
    }
    if (haystackDocuments) {
      metadata.haystackDocuments = haystackDocuments
    }
    if (isDocumentSearch) {
      metadata.isDocumentSearch = true
    }

    const message: ThunderboltUIMessage = {
      id,
      role: 'assistant',
      parts,
    }

    if (Object.keys(metadata).length > 0) {
      message.metadata = metadata
    }

    return message
  }

  const handleUpdate = (update: SessionUpdate): ThunderboltUIMessage => {
    switch (update.sessionUpdate) {
      case 'agent_message_chunk':
        if (update.content.type === 'text') {
          textContent += update.content.text
        }
        // Capture Haystack references from _meta on ContentChunk
        if (update._meta?.haystackReferences) {
          haystackReferences = update._meta.haystackReferences as HaystackReferenceMeta[]
          isDocumentSearch = true
        }
        break

      case 'agent_thought_chunk':
        if (update.content.type === 'text') {
          reasoningContent += update.content.text
        }
        break

      case 'tool_call':
        toolCalls.set(update.toolCallId, {
          toolCallId: update.toolCallId,
          toolName: update.title,
          status: (update.status as ToolCallState['status']) ?? 'pending',
          args: {},
          result: undefined,
        })
        break

      case 'tool_call_update': {
        const existing = toolCalls.get(update.toolCallId)
        if (existing) {
          existing.status = (update.status as ToolCallState['status']) ?? existing.status

          if (update.content && update.content.length > 0) {
            const resultText = update.content
              .filter(
                (c): c is { type: 'content'; content: { type: 'text'; text: string } } =>
                  c.type === 'content' && c.content.type === 'text',
              )
              .map((c) => c.content.text)
              .join('\n')
            existing.result = resultText
          }
        }
        break
      }
    }

    return buildMessage()
  }

  return {
    handleUpdate,
    buildMessage,
    setHaystackDocuments(docs: HaystackDocumentMeta[]) {
      haystackDocuments = docs
      isDocumentSearch = true
    },
    setHaystackReferences(refs: HaystackReferenceMeta[]) {
      haystackReferences = refs
      isDocumentSearch = true
    },
    get id() {
      return id
    },
    get hasContent() {
      return textContent.length > 0 || reasoningContent.length > 0 || toolCalls.size > 0
    },
  }
}

export type MessageAccumulator = ReturnType<typeof createMessageAccumulator>
