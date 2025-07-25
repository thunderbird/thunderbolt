import type { LanguageModelV2Middleware, LanguageModelV2StreamPart } from '@ai-sdk/provider'
import { generateId } from 'ai'
import type { TransformStreamDefaultController } from 'stream/web'

const MAX_TAG_LEN = 64
const ARG_BEGIN_SENTINEL = '<|tool_call_argument_begin|>'

/** Utility that normalises a raw "functions.foo:1" header. */
const parseToolNameAndId = (raw: string): { toolName: string; toolCallId: string } => {
  let header = raw.trim()

  // Extract numeric id after the last ':' if present
  let toolCallId: string | undefined
  const idMatch = header.match(/:(\d+)$/)
  if (idMatch) {
    toolCallId = idMatch[1]
    header = header.slice(0, idMatch.index)
  }

  // Remove leading namespace and convert to snake_case
  let toolName = header.replace(/^functions\./i, '')
  toolName = toolName
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/-/g, '_')
    .toLowerCase()

  return { toolName, toolCallId: toolCallId ?? generateId() }
}

type StackNode = { 
  name: string
  content: string
  toolCallId?: string
  toolName?: string
  emitted?: boolean // Track if we've already emitted the opening part
}

/**
 * Streaming middleware that accumulates content within think tags and emits
 * as a single reasoning part at the end, for compatibility with existing tests.
 */
export const streamingParserMiddleware: LanguageModelV2Middleware = {
  wrapStream: async ({ doStream }) => {
    const { stream, ...rest } = await doStream()

    // State for streaming tag detection
    let buffer = ''
    let inThinking = false
    let thinkingContent = ''

    const transform = new TransformStream<LanguageModelV2StreamPart, LanguageModelV2StreamPart>({
      transform(
        chunk: LanguageModelV2StreamPart,
        controller: TransformStreamDefaultController<LanguageModelV2StreamPart>,
      ) {
        // Fast-path: non-text chunks are forwarded untouched
        if ((chunk as any).type !== 'text') {
          controller.enqueue(chunk)
          return
        }

        const text = (chunk as any).text as string
        if (typeof text !== 'string' || text.length === 0) {
          controller.enqueue(chunk)
          return
        }

        // Add new text to buffer
        buffer += text

        // Process complete tags in buffer
        while (true) {
          if (!inThinking) {
            // Look for opening think tag
            const thinkStartIdx = buffer.indexOf('<think>')
            if (thinkStartIdx !== -1) {
              // Emit any text before the tag
              const beforeText = buffer.slice(0, thinkStartIdx)
              if (beforeText) {
                controller.enqueue({ type: 'text', text: beforeText } as any)
              }
              
              // Enter thinking mode
              inThinking = true
              thinkingContent = ''
              buffer = buffer.slice(thinkStartIdx + '<think>'.length)
              continue
            } else {
              // No think tag found, emit all buffer as text if we have enough
              // Keep some chars in buffer in case tag is split across chunks
              if (buffer.length > 10) {
                const toEmit = buffer.slice(0, -10)
                controller.enqueue({ type: 'text', text: toEmit } as any)
                buffer = buffer.slice(-10)
              }
              break
            }
          } else {
            // We're in thinking mode, look for closing tag
            const thinkEndIdx = buffer.indexOf('</think>')
            if (thinkEndIdx !== -1) {
              // Add content before closing tag to thinking content
              thinkingContent += buffer.slice(0, thinkEndIdx)
              
              // Emit the complete reasoning part
              if (thinkingContent) {
                controller.enqueue({ type: 'reasoning', text: thinkingContent.trim() } as any)
              }
              
              // Exit thinking mode
              inThinking = false
              thinkingContent = ''
              buffer = buffer.slice(thinkEndIdx + '</think>'.length)
              continue
            } else {
              // No closing tag yet, add to thinking content but keep some in buffer
              if (buffer.length > 10) {
                thinkingContent += buffer.slice(0, -10)
                buffer = buffer.slice(-10)
              }
              break
            }
          }
        }
      },

      flush(controller: TransformStreamDefaultController<LanguageModelV2StreamPart>) {
        // Flush any remaining buffer
        if (buffer) {
          if (inThinking) {
            thinkingContent += buffer
            if (thinkingContent) {
              controller.enqueue({ type: 'reasoning', text: thinkingContent.trim() } as any)
            }
          } else {
            controller.enqueue({ type: 'text', text: buffer } as any)
          }
        }
      },
    })

    return { stream: stream.pipeThrough(transform), ...rest }
  },

  wrapGenerate: async ({ doGenerate }) => doGenerate(),
}