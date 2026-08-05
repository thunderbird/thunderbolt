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
const argsMax = 100
/** Max length of a tool-result preview before it's ellipsized. */
const previewMax = 160
/** Lines of a tool result shown as a preview. */
const previewLines = 2

/**
 * Matches whole ANSI escape sequences: CSI (`ESC[…`), OSC (`ESC]…` up to a BEL
 * or ST terminator), and any other `ESC`-introduced form (two-byte escapes down
 * to a lone `ESC`). The lone-`ESC` alternative is last so a split or unterminated
 * sequence still loses its introducer and degrades to inert printable text. The
 * OSC body is a negated class (not `.*?`) so an unterminated introducer stops at
 * the next `ESC`/BEL instead of rescanning to the end — keeping the pass linear
 * on hostile input like a long run of bare `ESC]`.
 */
const escapeSequencePattern = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-_]?/g
/**
 * Matches lone C0/C1 control bytes (and DEL) that survive escape-sequence
 * removal, deliberately sparing tab (`\x09`) and newline (`\x0a`) — the only
 * whitespace the renderer lays out on.
 */
const controlCharPattern = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/g

/**
 * Neutralizes terminal control sequences in untrusted text (tool output,
 * model-influenced arguments, assistant prose) before it reaches the operator's
 * terminal. Strips ANSI escape sequences — OSC 52 clipboard writes, window-title
 * and hyperlink spoofs, CSI cursor moves — and lone control bytes, while
 * preserving the tab and newline the renderer relies on. Apply this at the trust
 * boundary, before wrapping the text in the app's own color SGR.
 *
 * @param text - the untrusted text to sanitize
 * @returns the text with escape sequences and stray control bytes removed
 */
export const sanitizeTerminalText = (text: string): string =>
  text.replace(escapeSequencePattern, '').replace(controlCharPattern, '')

/**
 * Sanitizes untrusted text for an approval summary and keeps it on one visible
 * line so model-controlled whitespace cannot imitate prompt structure.
 *
 * @param text - the model-controlled approval text
 * @returns terminal-safe text with tabs and newlines rendered literally
 */
export const sanitizePermissionText = (text: string): string =>
  sanitizeTerminalText(text).replaceAll('\n', '\\n').replaceAll('\t', '\\t')

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
  if (typeof record.command === 'string') return sanitizeTerminalText(record.command)
  if (typeof record.path === 'string') return sanitizeTerminalText(record.path)
  return sanitizeTerminalText(JSON.stringify(record))
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
  const text = sanitizeTerminalText(
    content
      .filter(isTextBlock)
      .map((block) => block.text)
      .join(''),
  ).trim()
  return truncate(text.split('\n').slice(0, previewLines).join('\n'), previewMax)
}

/**
 * Formats the colored header that announces a tool invocation, e.g.
 * `⏺ bash npm test`. Returns a single line with no surrounding whitespace so
 * callers can frame it for their medium (stdout stream or a TUI component).
 *
 * @param toolName - the tool being invoked
 * @param args - the tool's arguments, summarized to one line
 * @returns the styled, single-line header
 */
export const formatToolStart = (toolName: string, args: unknown): string => {
  const header = `${symbols.tool} ${cyan(toolName)}`
  const summary = truncate(summarizeArgs(args), argsMax)
  return summary ? `${header} ${gray(summary)}` : header
}

/**
 * Formats the success/failure marker for a finished tool call, with a short
 * result preview. Returns a single line with no surrounding whitespace.
 *
 * @param isError - whether the tool result is an error
 * @param result - the tool result to preview
 * @returns the styled, single-line marker
 */
export const formatToolEnd = (isError: boolean, result: unknown): string => {
  const mark = isError ? red(symbols.fail) : green(symbols.ok)
  const preview = previewResult(result)
  return preview ? `${mark} ${gray(preview)}` : mark
}

/**
 * Formats a turn that ended in a provider error (auth failure, rate limit, a
 * bad request). Pi resolves the turn instead of throwing — the failure rides on
 * the assistant message's `stopReason`/`errorMessage` — so without surfacing it
 * the CLI would print nothing and look like a silent no-op.
 *
 * @param message - the assistant message attached to a `turn_end` event
 * @returns the styled error line, or `undefined` when the turn did not error
 */
export const formatTurnError = (message: AgentMessage): string | undefined => {
  if (!('stopReason' in message) || message.stopReason !== 'error') return undefined
  const detail = sanitizeTerminalText(message.errorMessage ?? 'the request failed')
  return red(`${symbols.fail} ${detail}`)
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
            process.stdout.write(sanitizeTerminalText(inner.delta))
            break
          case 'thinking_delta':
            process.stdout.write(dim(sanitizeTerminalText(inner.delta)))
            break
        }
        break
      }
      case 'tool_execution_start':
        process.stdout.write(`\n${formatToolStart(event.toolName, event.args)}\n`)
        break
      case 'tool_execution_end':
        process.stdout.write(`${formatToolEnd(event.isError, event.result)}\n`)
        break
      case 'turn_end': {
        const error = formatTurnError(event.message)
        if (error) process.stderr.write(`\n${error}\n`)
        break
      }
    }
  })
}
