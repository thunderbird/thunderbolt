import type { SessionNotification } from '@agentclientprotocol/sdk'
import type { DocumentMeta, DocumentReference, ThunderboltUIMessage, UIMessageMetadata } from '@/types'
import type { SourceMetadata } from '@/types/source'
import { v7 as uuidv7 } from 'uuid'
import { z } from 'zod'

export type SessionUpdate = SessionNotification['update']

type ToolCallState = {
  toolCallId: string
  toolName: string
  title?: string
  status: 'pending' | 'in_progress' | 'completed' | 'failed'
  args: Record<string, unknown>
  result: unknown
  startTime: number
}

type OrderedPart =
  | { kind: 'text'; text: string }
  | { kind: 'reasoning'; text: string; id: string; startTime: number }
  | { kind: 'tool'; state: ToolCallState }

const documentReferenceSchema = z.object({
  position: z.number(),
  fileId: z.string(),
  fileName: z.string(),
  pageNumber: z.number().optional(),
})

const documentMetaSchema = z.object({
  haystackReferences: z.array(documentReferenceSchema).optional(),
  haystackDocuments: z
    .array(
      z.object({
        id: z.string(),
        content: z.string(),
        score: z.number(),
        file: z.object({ id: z.string(), name: z.string() }),
      }),
    )
    .optional(),
})

export const parseMeta = (
  meta: unknown,
): { documentReferences?: DocumentReference[]; documents?: DocumentMeta[] } | null => {
  const result = documentMetaSchema.safeParse(meta)
  if (!result.success) {
    console.warn('[message-accumulator] _meta did not match expected shape:', result.error.flatten())
    return null
  }
  const { haystackReferences, haystackDocuments } = result.data
  return {
    ...(haystackReferences !== undefined && { documentReferences: haystackReferences }),
    ...(haystackDocuments !== undefined && { documents: haystackDocuments }),
  }
}

/**
 * Accumulates ACP streaming updates into a ThunderboltUIMessage.
 * Each prompt creates a new accumulator for the assistant response.
 *
 * Maintains an ordered list of parts (text, reasoning, tool) to preserve
 * interleaving across multiple agent steps, along with timing data for
 * tool calls and reasoning blocks.
 */
export const createMessageAccumulator = (messageId?: string) => {
  const id = messageId ?? uuidv7()

  const orderedParts: OrderedPart[] = []
  const toolCallMap = new Map<string, ToolCallState>()

  const reasoningStartTimes: Record<string, number> = {}
  const reasoningTime: Record<string, number> = {}
  let reasoningCounter = 0

  let documentReferences: DocumentReference[] | undefined
  let documents: DocumentMeta[] | undefined
  let sources: SourceMetadata[] | undefined

  const buildMessage = (): ThunderboltUIMessage => {
    const parts: ThunderboltUIMessage['parts'] = []

    for (const op of orderedParts) {
      switch (op.kind) {
        case 'reasoning':
          parts.push({
            type: 'reasoning',
            text: op.text,
            providerMetadata: {},
          })
          break

        case 'tool': {
          const tc = op.state
          const base = {
            type: `tool-${tc.toolName}` as const,
            toolCallId: tc.toolCallId,
            title: tc.title,
          }
          if (tc.status === 'completed') {
            parts.push({ ...base, state: 'output-available' as const, input: tc.args, output: tc.result })
          } else if (tc.status === 'failed') {
            parts.push({
              ...base,
              state: 'output-error' as const,
              input: tc.args,
              errorText: String(tc.result ?? 'Unknown error'),
            })
          } else {
            parts.push({ ...base, state: 'input-available' as const, input: tc.args })
          }
          break
        }

        case 'text':
          if (op.text) {
            parts.push({ type: 'text', text: op.text })
          }
          break
      }
    }

    // Fallback for empty message
    if (parts.length === 0) {
      parts.push({ type: 'text', text: '' })
    }

    // Build metadata
    const metadata: UIMessageMetadata = {}
    if (documentReferences) {
      metadata.documentReferences = documentReferences
    }
    if (documents) {
      metadata.documents = documents
    }
    if (sources && sources.length > 0) {
      metadata.sources = sources
    }
    if (Object.keys(reasoningTime).length > 0) {
      metadata.reasoningTime = reasoningTime
    }
    if (Object.keys(reasoningStartTimes).length > 0) {
      metadata.reasoningStartTimes = reasoningStartTimes
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
      case 'agent_message_chunk': {
        if (update.content.type === 'text') {
          const last = orderedParts[orderedParts.length - 1]

          // Close previous reasoning part's timing if applicable
          if (last?.kind === 'reasoning') {
            reasoningTime[last.id] = Date.now() - last.startTime
          }

          if (last?.kind === 'text') {
            last.text += update.content.text
          } else {
            orderedParts.push({ kind: 'text', text: update.content.text })
          }
        }
        if (update._meta) {
          const meta = parseMeta(update._meta)
          if (meta?.documentReferences) {
            documentReferences = meta.documentReferences
          }
          if (meta?.documents) {
            documents = meta.documents
          }
        }
        break
      }

      case 'agent_thought_chunk': {
        if (update.content.type === 'text') {
          const last = orderedParts[orderedParts.length - 1]
          if (last?.kind === 'reasoning') {
            last.text += update.content.text
          } else {
            const partId = `reasoning-${reasoningCounter++}`
            const startTime = Date.now()
            orderedParts.push({ kind: 'reasoning', text: update.content.text, id: partId, startTime })
            reasoningStartTimes[partId] = startTime
          }
        }
        break
      }

      case 'tool_call': {
        const startTime = Date.now()
        const toolCallState: ToolCallState = {
          toolCallId: update.toolCallId,
          toolName: update.title,
          title: update.title,
          status: (update.status as ToolCallState['status']) ?? 'pending',
          args: {},
          result: undefined,
          startTime,
        }
        orderedParts.push({ kind: 'tool', state: toolCallState })
        toolCallMap.set(update.toolCallId, toolCallState)
        reasoningStartTimes[update.toolCallId] = startTime
        break
      }

      case 'tool_call_update': {
        const existing = toolCallMap.get(update.toolCallId)
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

          if (existing.status === 'completed' || existing.status === 'failed') {
            reasoningTime[existing.toolCallId] = Date.now() - existing.startTime
          }
        }

        // Progressive source updates from tool results
        if (update._meta) {
          const rawSources = (update._meta as Record<string, unknown>)?.sources
          if (Array.isArray(rawSources)) {
            sources = rawSources as SourceMetadata[]
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
    setDocuments(docs: DocumentMeta[]) {
      documents = docs
    },
    setDocumentReferences(refs: DocumentReference[]) {
      documentReferences = refs
    },
    setSources(s: SourceMetadata[]) {
      sources = s
    },
    get id() {
      return id
    },
    get hasContent() {
      return orderedParts.length > 0
    },
  }
}

export type MessageAccumulator = ReturnType<typeof createMessageAccumulator>
