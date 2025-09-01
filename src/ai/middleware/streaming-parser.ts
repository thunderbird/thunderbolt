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
 * Streaming middleware that immediately emits reasoning and tool-call parts
 * when their opening tags are detected, rather than waiting for closing tags.
 */
export const streamingParserMiddleware: LanguageModelV2Middleware = {
  wrapStream: async ({ doStream }) => {
    const { stream, ...rest } = await doStream()

    // Runtime state
    let textBuffer = ''
    let tagBuffer = '' // For <| tags
    let htmlTagBuffer = '' // For <think> tags
    const stack: StackNode[] = []

    /** Helper: emit accumulated text buffer as a text part */
    const flushTextBuffer = (controller: TransformStreamDefaultController<LanguageModelV2StreamPart>) => {
      if (textBuffer.length > 0) {
        controller.enqueue({ type: 'text', text: textBuffer } as any)
        textBuffer = ''
      }
    }

    /** Helper: emit text immediately to the current context */
    const emitText = (text: string, controller: TransformStreamDefaultController<LanguageModelV2StreamPart>) => {
      if (!text) return

      if (stack.length > 0) {
        const currentNode = stack[stack.length - 1]
        currentNode.content += text

        // If we're in a reasoning context, emit the text immediately
        if (currentNode.name === 'think') {
          controller.enqueue({ type: 'reasoning', text } as any)
        }
        // For tool calls, we accumulate until we have complete args
      } else {
        // We're at root level, emit as regular text
        controller.enqueue({ type: 'text', text } as any)
      }
    }

    /** Handle HTML-style tags like <think> and </think> */
    const handleHtmlTag = (tag: string, controller: TransformStreamDefaultController<LanguageModelV2StreamPart>) => {
      if (tag === 'think') {
        // Opening think tag - flush any pending text first
        flushTextBuffer(controller)
        // Start reasoning context
        stack.push({ name: 'think', content: '', emitted: true })
      } else if (tag === '/think') {
        // Closing think tag
        if (stack.length > 0 && stack[stack.length - 1].name === 'think') {
          stack.pop()
        }
      }
      // Ignore other HTML tags and emit them as regular text
      else {
        emitText(`<${tag}>`, controller)
      }
    }

    /** Handle sentinel tags like <|tool_call_begin|> */
    const handleSentinelToken = (
      token: string,
      controller: TransformStreamDefaultController<LanguageModelV2StreamPart>,
    ) => {
      // If we're currently inside a tool_call, copy everything literally until
      // we see its corresponding _end tag.
      if (stack.length > 0 && stack[stack.length - 1].name === 'tool_call' && token !== 'tool_call_end') {
        stack[stack.length - 1].content += `<|${token}|>`
        return
      }

      if (token.endsWith('_begin')) {
        const name = token.slice(0, -6) // remove "_begin"
        if (name === 'tool_call') {
          // Start a new tool call context
          stack.push({ name: 'tool_call', content: '', emitted: false })
        } else {
          // Other types, just push to stack
          stack.push({ name, content: '', emitted: false })
        }
      } else if (token.endsWith('_end')) {
        const name = token.slice(0, -4) // remove "_end"
        if (stack.length > 0 && stack[stack.length - 1].name === name) {
          const node = stack.pop()!

          if (name === 'tool_call') {
            // Emit the complete tool call
            const argIdx = node.content.indexOf(ARG_BEGIN_SENTINEL)
            const headerPart = (argIdx === -1 ? node.content : node.content.slice(0, argIdx)).trim()
            const argsRaw = argIdx === -1 ? '' : node.content.slice(argIdx + ARG_BEGIN_SENTINEL.length).trim()

            const { toolName, toolCallId } = parseToolNameAndId(headerPart)

            controller.enqueue({
              type: 'tool-call',
              toolCallId,
              toolName,
              args: argsRaw.trim(),
            } as any)
          }
        }
      } else {
        // Stateless tag - copy literally to current destination
        if (stack.length > 0) {
          stack[stack.length - 1].content += `<|${token}|>`
        } else {
          textBuffer += `<|${token}|>`
        }
      }
    }

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

        for (let i = 0; i < text.length; i++) {
          const char = text[i]

          // -----------------------------------------------------------------
          // Handle HTML tags like <think>
          // -----------------------------------------------------------------
          if (htmlTagBuffer.length > 0 || (char === '<' && i + 1 < text.length && text[i + 1] !== '|')) {
            if (htmlTagBuffer.length === 0 && char === '<') {
              // Potential start of HTML tag (but not sentinel tag)
              htmlTagBuffer = '<'
              continue
            }

            htmlTagBuffer += char

            if (char === '>') {
              // Complete HTML tag
              const tagContent = htmlTagBuffer.slice(1, -1) // Remove < and >
              handleHtmlTag(tagContent, controller)
              htmlTagBuffer = ''
              continue
            }

            if (htmlTagBuffer.length > MAX_TAG_LEN) {
              // Too long, not a real tag
              emitText(htmlTagBuffer, controller)
              htmlTagBuffer = ''
              // Re-process this character
              i--
              continue
            }

            // Continue collecting HTML tag
            continue
          }

          // -----------------------------------------------------------------
          // Handle sentinel tags like <|token|>
          // -----------------------------------------------------------------
          if (tagBuffer.length > 0 || char === '<') {
            if (tagBuffer.length === 0 && char === '<') {
              // Potential start of sentinel tag
              tagBuffer = '<'
              continue
            }

            if (tagBuffer.length >= MAX_TAG_LEN) {
              emitText(tagBuffer, controller)
              tagBuffer = ''
              // Re-process this char from scratch
              i--
              continue
            }

            tagBuffer += char

            // Special handling for the first two chars: we require "<|"
            if (tagBuffer.length === 2) {
              if (tagBuffer !== '<|') {
                // Not actually a sentinel tag
                emitText(tagBuffer, controller)
                tagBuffer = ''
                continue
              }
              // Otherwise exactly "<|" so continue collecting
              continue
            }

            // Check for completion: sentinel tag must end with "|>"
            if (tagBuffer.endsWith('|>')) {
              const tokenInner = tagBuffer.slice(2, -2) // remove delimiters
              tagBuffer = ''
              handleSentinelToken(tokenInner, controller)
              continue
            }

            // Continue collecting sentinel tag
            continue
          }

          // -----------------------------------------------------------------
          // Regular character - emit to current context
          // -----------------------------------------------------------------
          emitText(char, controller)
        }
      },

      flush(controller: TransformStreamDefaultController<LanguageModelV2StreamPart>) {
        // Flush any dangling buffers as literal text
        if (tagBuffer.length > 0) {
          emitText(tagBuffer, controller)
        }
        if (htmlTagBuffer.length > 0) {
          emitText(htmlTagBuffer, controller)
        }

        // If there are still open tags, emit their raw representation
        if (stack.length > 0) {
          let leftover = ''
          while (stack.length > 0) {
            const node = stack.shift()!
            if (node.name === 'think') {
              leftover += `<${node.name}>` + node.content
            } else {
              leftover += `<|${node.name}_begin|>` + node.content
            }
          }
          if (leftover) {
            controller.enqueue({ type: 'text', text: leftover } as any)
          }
        }

        // Finally flush any accumulated text buffer
        flushTextBuffer(controller)
      },
    })

    return { stream: stream.pipeThrough(transform), ...rest }
  },

  wrapGenerate: async ({ doGenerate }) => doGenerate(),
}
