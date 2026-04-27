/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { LanguageModelV2Middleware, LanguageModelV2StreamPart } from '@ai-sdk/provider'
import { generateId } from 'ai'
import type { TransformStreamDefaultController } from 'stream/web'

const maxTagLen = 64
const argBeginSentinel = '<|tool_call_argument_begin|>'

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

/** Parse the content accumulated inside a <|tool_call_begin|> … <|tool_call_end|> block. */
const emitToolCall = (content: string, controller: TransformStreamDefaultController<LanguageModelV2StreamPart>) => {
  const argIdx = content.indexOf(argBeginSentinel)
  const headerPart = (argIdx === -1 ? content : content.slice(0, argIdx)).trim()
  const argsRaw = argIdx === -1 ? '' : content.slice(argIdx + argBeginSentinel.length).trim()

  const { toolName, toolCallId } = parseToolNameAndId(headerPart)

  // The tests expect `args` to be a *string* (raw JSON).  Downstream code can
  // decide whether to parse it.  We therefore forward the raw substring as-is.
  controller.enqueue({
    type: 'tool-call',
    toolCallId,
    toolName,
    args: argsRaw.trim(),
  } as any)
}

type StackNode = { name: string; content: string }

/**
 * Middleware to parse tool calls (eg <|tool_call_begin|> … <|tool_call_end|>) from the streaming response.
 */
export const toolCallsMiddleware: LanguageModelV2Middleware = {
  /** Intercept the streaming response so we can parse tool-call blocks. */
  wrapStream: async ({ doStream }) => {
    const { stream, ...rest } = await doStream()

    // Runtime state as described in the specification
    let textBuffer = ''
    let tagBuffer = '' // Holds characters after seeing the opening "<|"
    const stack: StackNode[] = []

    /** Helper: append plain text to the correct destination. */
    const appendText = (text: string) => {
      if (!text) {
        return
      }
      if (stack.length > 0) {
        stack[stack.length - 1].content += text
      } else {
        textBuffer += text
      }
    }

    /** Helper: flush the text buffer downstream if we are at root level. */
    const flushTextIfPossible = (controller: TransformStreamDefaultController<LanguageModelV2StreamPart>) => {
      if (stack.length === 0 && textBuffer.length > 0) {
        controller.enqueue({ type: 'text', text: textBuffer } as any)
        textBuffer = ''
      }
    }

    /** Handle a completed tag token. */
    const handleToken = (token: string, controller: TransformStreamDefaultController<LanguageModelV2StreamPart>) => {
      // If we're currently inside a tool_call, copy everything literally until
      // we see its corresponding _end tag.  This prevents nested tags (such as
      // <|tool_call_argument_begin|>) from being interpreted by our parser.
      if (stack.length > 0 && stack[stack.length - 1].name === 'tool_call' && token !== 'tool_call_end') {
        stack[stack.length - 1].content += `<|${token}|>`
        return
      }

      if (token.endsWith('_begin')) {
        const name = token.slice(0, -6) // remove "_begin"
        stack.push({ name, content: '' })
        return
      }

      if (token.endsWith('_end')) {
        const name = token.slice(0, -4) // remove "_end"
        if (stack.length > 0 && stack[stack.length - 1].name === name) {
          const node = stack.pop()!

          if (name === 'tool_call') {
            emitToolCall(node.content, controller)
          } else {
            // Attach the inner content to its parent or to the root textBuffer
            if (stack.length > 0) {
              stack[stack.length - 1].content += node.content
            } else {
              textBuffer += node.content
            }
          }
        } else {
          // Unmatched end (e.g., stray duplicate) – safely ignore.
          return
        }
        return
      }

      // Stateless tag – copy literally to current destination
      appendText(`<|${token}|>`) // includes the sentinels
    }

    const transform = new TransformStream<any, any>({
      transform(
        chunk: LanguageModelV2StreamPart,
        controller: TransformStreamDefaultController<LanguageModelV2StreamPart>,
      ) {
        if ((chunk as any).type !== 'text') {
          controller.enqueue(chunk as any)
          return
        }

        const text = (chunk as any).text as string | undefined
        if (typeof text !== 'string') {
          controller.enqueue(chunk)
          return
        }

        for (let i = 0; i < text.length; i++) {
          const char = text[i]

          // -----------------------------------------------------------------
          // We are NOT currently inside a potential tag
          // -----------------------------------------------------------------
          if (tagBuffer.length === 0) {
            if (char === '<') {
              // Potential start of a tag – start buffering
              tagBuffer = '<'
            } else {
              appendText(char)
            }
            continue
          }

          // -----------------------------------------------------------------
          // We ARE collecting a potential tag
          // -----------------------------------------------------------------
          // First, ensure we don't exceed maxTagLen
          if (tagBuffer.length >= maxTagLen) {
            appendText(tagBuffer)
            tagBuffer = ''
            // Re-process this char from scratch in the outer loop
            i--
            continue
          }

          tagBuffer += char

          // Special handling for the first two chars: we require "<|".
          if (tagBuffer.length === 2) {
            if (tagBuffer !== '<|') {
              // Not actually a tag. Flush and continue treating normally.
              appendText(tagBuffer)
              tagBuffer = ''
              continue
            }
            // Otherwise exactly "<|" so continue collecting.
            continue
          }

          // Check for completion: tag must end with "|>"
          if (tagBuffer.endsWith('|>')) {
            const tokenInner = tagBuffer.slice(2, -2) // remove delimiters
            tagBuffer = ''

            handleToken(tokenInner, controller)

            // After processing, flush any ready plain text if at root
            flushTextIfPossible(controller)
          }
        }

        // At chunk boundary, attempt to flush any accumulated text if we're at root
        flushTextIfPossible(controller)
      },

      flush(controller: TransformStreamDefaultController<LanguageModelV2StreamPart>) {
        // Flush any dangling tagBuffer as literal text
        if (tagBuffer.length > 0) {
          appendText(tagBuffer)
          tagBuffer = ''
        }

        // If there are still open tags, output their raw representation to avoid data loss
        if (stack.length > 0) {
          let leftover = ''
          while (stack.length > 0) {
            const node = stack.shift()!
            leftover += `<|${node.name}_begin|>` + node.content
          }
          textBuffer += leftover
        }

        // Finally flush whatever text we have accumulated
        if (textBuffer.length > 0) {
          controller.enqueue({ type: 'text', text: textBuffer } as any)
          textBuffer = ''
        }
      },
    })

    return { stream: stream.pipeThrough(transform), ...rest }
  },

  /** Generation wrapper – untouched */
  wrapGenerate: async ({ doGenerate }) => doGenerate(),
}
