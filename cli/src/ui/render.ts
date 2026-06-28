/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Streaming terminal renderer for the thunderbolt CLI. Subscribes to a Pi
 * `AgentHarness` and pretty-prints the run as it happens: assistant prose,
 * subdued thinking, and colored tool-call activity.
 */

import type { AgentHarness, AgentMessage } from '@earendil-works/pi-agent-core'
import { cyan, dim, gray, green, red, symbols } from './theme.ts'

/** Max length of a tool-call argument summary before it's ellipsized. */
const ARGS_MAX = 100
/** Max length of a tool-result preview before it's ellipsized. */
const PREVIEW_MAX = 160
/** Lines of a tool result shown as a preview. */
const PREVIEW_LINES = 2

/**
 * Truncates `text` to `max` characters, appending an ellipsis when clipped.
 *
 * @param text - the text to bound
 * @param max - maximum length including the ellipsis
 * @returns the original text, or a truncated copy ending in `…`
 */
const truncate = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text)

/**
 * Derives a one-line summary of a tool call's arguments: the shell command for
 * `bash`, the target path for `read`/`write`/`edit`, or compact JSON otherwise.
 *
 * @param args - the tool's arguments (Pi types these loosely, so narrow here)
 * @returns a single-line, untruncated summary
 */
const summarizeArgs = (args: unknown): string => {
  if (typeof args !== 'object' || args === null) return ''
  const record = args as Record<string, unknown>
  if (typeof record.command === 'string') return record.command
  if (typeof record.path === 'string') return record.path
  return JSON.stringify(record)
}

/** Narrows an unknown tool-result content block to one carrying text. */
const isTextBlock = (block: unknown): block is { text: string } =>
  typeof block === 'object' && block !== null && typeof (block as { text?: unknown }).text === 'string'

/**
 * Extracts a short preview from a Pi tool result by concatenating its text
 * content blocks, then keeping the first couple of lines.
 *
 * @param result - the tool result (`{ content: [{ type, text }] }`)
 * @returns a trimmed, line- and length-bounded preview (empty when none)
 */
const previewResult = (result: unknown): string => {
  if (typeof result !== 'object' || result === null) return ''
  const content = (result as { content?: unknown }).content
  if (!Array.isArray(content)) return ''
  const text = content
    .filter(isTextBlock)
    .map((block) => block.text)
    .join('')
    .trim()
  return truncate(text.split('\n').slice(0, PREVIEW_LINES).join('\n'), PREVIEW_MAX)
}

/** Writes the colored header that announces a tool invocation. */
const renderToolStart = (toolName: string, args: unknown): void => {
  const header = `${symbols.tool} ${cyan(toolName)}`
  const summary = truncate(summarizeArgs(args), ARGS_MAX)
  process.stdout.write(`\n${summary ? `${header} ${gray(summary)}` : header}\n`)
}

/** Writes the success/failure marker for a finished tool call, with a preview. */
const renderToolEnd = (isError: boolean, result: unknown): void => {
  const mark = isError ? red(symbols.fail) : green(symbols.ok)
  const preview = previewResult(result)
  process.stdout.write(preview ? `${mark} ${gray(preview)}\n` : `${mark}\n`)
}

/**
 * Surfaces a turn that ended in a provider error (auth failure, rate limit, a
 * bad request). Pi resolves the turn instead of throwing — the failure rides on
 * the assistant message's `stopReason`/`errorMessage` — so without this the CLI
 * would print nothing and look like a silent no-op.
 *
 * @param message - the assistant message attached to a `turn_end` event
 */
const renderTurnError = (message: AgentMessage): void => {
  if (!('stopReason' in message) || message.stopReason !== 'error') return
  const detail = message.errorMessage ?? 'the request failed'
  process.stderr.write(`\n${red(`${symbols.fail} ${detail}`)}\n`)
}

/**
 * Attaches a streaming renderer to a harness. Subscribes for the harness's
 * lifetime and writes assistant text, thinking, and tool activity to stdout as
 * events arrive.
 *
 * @param harness - the Pi harness whose run should be rendered
 */
export const attachRenderer = (harness: AgentHarness): void => {
  harness.subscribe((event) => {
    switch (event.type) {
      case 'message_update': {
        const inner = event.assistantMessageEvent
        switch (inner.type) {
          case 'text_delta':
            process.stdout.write(inner.delta)
            break
          case 'thinking_delta':
            process.stdout.write(dim(inner.delta))
            break
        }
        break
      }
      case 'tool_execution_start':
        renderToolStart(event.toolName, event.args)
        break
      case 'tool_execution_end':
        renderToolEnd(event.isError, event.result)
        break
      case 'turn_end':
        renderTurnError(event.message)
        break
    }
  })
}
