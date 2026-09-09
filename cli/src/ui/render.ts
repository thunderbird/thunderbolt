/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Streaming terminal renderer for the thunderbolt CLI. Subscribes to a Pi
 * `HarnessRuntime` and pretty-prints the run as it happens: assistant prose,
 * subdued thinking, and colored tool-call activity.
 */

import type { AgentMessage } from '@earendil-works/pi-agent-core'
import type { AssistantMessageEvent } from '@earendil-works/pi-ai'
import type { HarnessRuntime } from '../provider-runtime/types.ts'
import { amber, dim, gray, green, red, spark, symbols } from './theme.ts'

export const workingStatusText = 'Working…'
const plainStreamingStatusText = `${workingStatusText} (Ctrl+C to interrupt)`
const errorRecoveryHints = {
  network: 'check your connection — your message is kept in history (↑)',
  auth: 'run /login to sign in again',
  byokAuth: "set the provider's environment variable, pass --api-key, or repair the profile with thunderbolt config",
  generic: 'retry the message — it is kept in history (↑)',
} as const

/** Selects the provider-error headline and recovery hint in priority order. */
const turnErrorPresentation = (detail: string, providerId: string | null): readonly [string, string] => {
  const normalized = detail.toLowerCase()
  if (/network|fetch|connect|unreachable|econn/.test(normalized)) return [detail, errorRecoveryHints.network]
  if (!/auth|session|unauthorized|401/.test(normalized)) return [detail, errorRecoveryHints.generic]
  if (providerId === 'thunderbolt') return ['Session expired', errorRecoveryHints.auth]
  return ['Provider rejected the credential', errorRecoveryHints.byokAuth]
}

/** Whether an assistant stream event carries content rather than protocol framing. */
export const isAssistantDelta = (event: AssistantMessageEvent): boolean =>
  event.type === 'text_delta' || event.type === 'thinking_delta' || event.type === 'toolcall_delta'

type RendererStream = {
  readonly isTTY?: boolean
  readonly write: (text: string) => void
}

type RendererStreams = {
  readonly stdout: RendererStream
  readonly stderr: RendererStream
}

type JsonValue = string | number | boolean | null | readonly JsonValue[] | { readonly [key: string]: JsonValue }
type ToolArguments = Readonly<{ command?: string; path?: string; [key: string]: JsonValue | undefined }> | null
export type ToolResultPreview = { readonly content?: readonly { readonly type?: string; readonly text?: string }[] }

/** Max length of a tool-call argument summary before it's ellipsized. */
const argsMax = 100
/** Max length of a tool-result preview before it's ellipsized. */
const previewMax = 160
/** Lines of a tool result shown as a preview. */
const previewLines = 2

export type StatusPhase = 'working' | 'reasoning'

/** Derives the waiting-state copy from an injected wall clock. */
export const statusLadderMessage = (startedAt: number, now: number, phase: StatusPhase): string => {
  const elapsedSeconds = Math.max(0, Math.floor((now - startedAt) / 1_000))
  if (phase === 'reasoning') return `Reasoning… ${elapsedSeconds}s`
  if (elapsedSeconds >= 15)
    return `Still working… ${elapsedSeconds}s — this model can take ~30s for the first token`
  return elapsedSeconds >= 4 ? `${workingStatusText} ${elapsedSeconds}s` : workingStatusText
}

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
const summarizeArgs = (args: ToolArguments): string => {
  if (args === null) return ''
  if (args.command !== undefined) return sanitizePermissionText(args.command)
  if (args.path !== undefined) return sanitizePermissionText(args.path)
  return sanitizePermissionText(JSON.stringify(args))
}

/**
 * Extracts a short preview from a Pi tool result by concatenating its text
 * content blocks, then keeping the first couple of lines.
 *
 * @param result - the tool result (`{ content: [{ type, text }] }`)
 * @returns a trimmed, line- and length-bounded preview (empty when none)
 */
const previewResult = (result: ToolResultPreview | null, max: number): string => {
  const content = result?.content
  if (content === undefined) return ''
  const text = sanitizeTerminalText(
    content
      .map((block) => block.text ?? '')
      .join(''),
  ).trim()
  return truncate(text.split('\n').slice(0, previewLines).join('\n'), max)
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
export const formatToolStart = (
  toolName: string,
  args: ToolArguments,
  width: number = process.stdout.columns ?? Infinity,
): string => {
  const header = `${gray(symbols.tool)} ${amber(toolName)}`
  const summary = truncate(summarizeArgs(args), Math.max(1, Math.min(argsMax, width - toolName.length - 3)))
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
export const formatToolEnd = (
  isError: boolean,
  result: ToolResultPreview | null,
  width: number = process.stdout.columns ?? Infinity,
): string => {
  const mark = isError ? red(symbols.fail) : green(symbols.ok)
  const preview = previewResult(result, Math.max(1, Math.min(previewMax, width - 4)))
  return preview ? `  ${mark} ${gray(preview.replaceAll('\n', '\n    '))}` : `  ${mark}`
}

/**
 * Formats a turn that ended in a provider error (auth failure, rate limit, a
 * bad request). Pi resolves the turn instead of throwing — the failure rides on
 * the assistant message's `stopReason`/`errorMessage` — so without surfacing it
 * the CLI would print nothing and look like a silent no-op.
 *
 * @param message - the assistant message attached to a `turn_end` event
 * @param providerId - the provider that produced the turn
 * @returns the styled error line, or `undefined` when the turn did not error
 */
export const formatTurnError = (message: AgentMessage, providerId: string | null): string | undefined => {
  if (!('stopReason' in message) || message.stopReason !== 'error') return undefined
  const detail = sanitizeTerminalText(message.errorMessage ?? 'the request failed')
  const [headline, recovery] = turnErrorPresentation(detail, providerId)
  return `${red(`${symbols.fail} ${headline}`)}\n${dim(`  ${recovery}`)}`
}

/**
 * Attaches a streaming renderer to a harness. Subscribes for the harness's
 * lifetime and writes assistant text, thinking, and tool activity to stdout as
 * events arrive.
 *
 * @param runtime - the harness runtime whose run should be rendered
 */
export const attachRenderer = (
  runtime: Pick<HarnessRuntime, 'currentProviderId' | 'subscribe'>,
  streams: RendererStreams = { stdout: process.stdout, stderr: process.stderr },
): void => {
  let status: string | undefined
  let thinking = false
  const showStatus = (message: string): void => {
    if (!streams.stderr.isTTY || status === message) return
    status = message
    streams.stderr.write(`\r\x1b[2K${spark()} ${message}`)
  }
  const clearStatus = (): void => {
    if (!status) return
    status = undefined
    streams.stderr.write('\r\x1b[2K')
  }

  runtime.subscribe((event) => {
    switch (event.type) {
      case 'agent_start':
      case 'turn_start':
        showStatus(workingStatusText)
        break
      case 'message_start':
        if (event.message.role === 'assistant') {
          thinking = false
          showStatus(plainStreamingStatusText)
        }
        break
      case 'message_update': {
        const inner = event.assistantMessageEvent
        if (isAssistantDelta(inner)) clearStatus()
        switch (inner.type) {
          case 'text_delta':
            streams.stdout.write(sanitizeTerminalText(inner.delta))
            break
          case 'thinking_delta':
            if (!thinking) {
              thinking = true
              streams.stdout.write(`${dim(`${symbols.thinking} thinking`)}\n`)
            }
            streams.stdout.write(dim(sanitizeTerminalText(inner.delta)))
            break
        }
        break
      }
      case 'message_end':
        if (event.message.role === 'assistant') clearStatus()
        break
      case 'agent_end':
      case 'abort':
        clearStatus()
        break
      case 'tool_execution_start':
        clearStatus()
        streams.stdout.write(`\n${formatToolStart(event.toolName, event.args)}\n`)
        break
      case 'tool_execution_end':
        streams.stdout.write(`${formatToolEnd(event.isError, event.result)}\n`)
        break
      case 'turn_end': {
        clearStatus()
        const error = formatTurnError(event.message, runtime.currentProviderId())
        if (error) streams.stderr.write(`\n${error}\n`)
        break
      }
    }
  })
}
