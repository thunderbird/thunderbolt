/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Coverage for the pure tool-activity formatters shared by the plain stdout
 * renderer and the TUI. Only the branchy string logic is tested (argument
 * summarizing, result previewing, truncation, and the error gate) — the ANSI
 * styling is environment-dependent, so assertions check for the meaningful
 * substrings rather than exact colored output.
 */

import type { AgentHarnessEvent, AgentMessage } from '@earendil-works/pi-agent-core'
import type { AssistantMessageEvent } from '@earendil-works/pi-ai'
import { describe, expect, test } from 'bun:test'
import {
  attachRenderer,
  formatToolEnd,
  formatToolStart,
  formatTurnError,
  sanitizeTerminalText,
  statusLadderMessage,
  type ToolResultPreview,
  workingStatusText,
} from './render.ts'
import { assistantMessage, assistantUpdate, rendererEvents } from './test-fixtures.ts'

/** A Pi tool result carrying a single text content block. */
const textResult = (text: string): ToolResultPreview => ({ content: [{ type: 'text', text }] })

test('status ladder derives working, reasoning, and reassurance from an injected clock', () => {
  const startedAt = 1_000

  expect(statusLadderMessage(startedAt, startedAt, 'working')).toBe(workingStatusText)
  expect(statusLadderMessage(startedAt, startedAt + 4_000, 'working')).toContain('4s')
  expect(statusLadderMessage(startedAt, startedAt + 12_000, 'reasoning')).toContain('Reasoning')
  expect(statusLadderMessage(startedAt, startedAt + 15_000, 'working')).toContain('~30s')
})

describe('attachRenderer — prompt status', () => {
  test('keeps TTY status through protocol starts and clears it before the first model delta', () => {
    const events = rendererEvents()
    const stdout: string[] = []
    const stderr: string[] = []
    attachRenderer(events.runtime, {
      stdout: { write: (text) => stdout.push(text) },
      stderr: { isTTY: true, write: (text) => stderr.push(text) },
    })

    const message = assistantMessage()
    events.emit({ type: 'agent_start' })
    events.emit({ type: 'message_start', message })
    expect(stderr.join('')).toContain(workingStatusText)
    expect(stderr.join('')).toContain('(Ctrl+C to interrupt)')
    expect(stdout).toEqual([])

    const statusWrites = stderr.length
    const starts: AssistantMessageEvent[] = [
      { type: 'start', partial: message },
      { type: 'text_start', contentIndex: 0, partial: message },
      { type: 'thinking_start', contentIndex: 1, partial: message },
      { type: 'toolcall_start', contentIndex: 2, partial: message },
    ]
    for (const start of starts) events.emit(assistantUpdate(message, start))
    expect(stderr).toHaveLength(statusWrites)

    events.emit(
      assistantUpdate(message, { type: 'text_delta', contentIndex: 0, delta: 'answer', partial: message }),
    )
    expect(stderr.at(-1)).toContain('\x1b[2K')
    expect(stdout.join('')).toBe('answer')
  })

  test('clears TTY status before tool activity is rendered', () => {
    const events = rendererEvents()
    const stdout: string[] = []
    const stderr: string[] = []
    attachRenderer(events.runtime, {
      stdout: { write: (text) => stdout.push(text) },
      stderr: { isTTY: true, write: (text) => stderr.push(text) },
    })
    events.emit({ type: 'agent_start' })

    events.emit({ type: 'tool_execution_start', toolCallId: 'tool-1', toolName: 'read', args: { path: 'a.ts' } })

    expect(stderr.at(-1)).toBe('\r\x1b[2K')
    expect(stdout.join('')).toContain('read')
  })

  test('does not print status when stderr is redirected', () => {
    const events = rendererEvents()
    const stderr: string[] = []
    attachRenderer(events.runtime, {
      stdout: { write: () => {} },
      stderr: { isTTY: false, write: (text) => stderr.push(text) },
    })

    events.emit({ type: 'agent_start' })
    events.emit({ type: 'message_start', message: assistantMessage() })

    expect(stderr).toEqual([])
  })

  test('clears TTY status on completion, abort, and error without a model delta', () => {
    const terminalEvents: AgentHarnessEvent[] = [
      { type: 'message_end', message: assistantMessage() },
      { type: 'agent_end', messages: [] },
      { type: 'abort', clearedSteer: [], clearedFollowUp: [] },
      {
        type: 'turn_end',
        message: { ...assistantMessage(), stopReason: 'error', errorMessage: '401 unauthorized' },
        toolResults: [],
      },
    ]

    for (const terminalEvent of terminalEvents) {
      const events = rendererEvents('anthropic-profile')
      const stderr: string[] = []
      attachRenderer(events.runtime, {
        stdout: { write: () => {} },
        stderr: { isTTY: true, write: (text) => stderr.push(text) },
      })
      events.emit({ type: 'agent_start' })

      events.emit(terminalEvent)

      expect(stderr).toContain('\r\x1b[2K')
      if (terminalEvent.type === 'turn_end') {
        expect(stderr.join('')).toContain('Provider rejected the credential')
        expect(stderr.join('')).not.toContain('Session expired')
      }
    }
  })
})

describe('sanitizeTerminalText — control-sequence stripping', () => {
  test('strips an OSC 52 clipboard-write sequence', () => {
    const result = sanitizeTerminalText('safe\x1b]52;c;aGVsbG8=\x07 after')
    expect(result).toBe('safe after')
    expect(result).not.toContain('\x1b')
  })

  test('strips a CSI cursor-move sequence', () => {
    expect(sanitizeTerminalText('a\x1b[2J\x1b[1;1Hb')).toBe('ab')
  })

  test('strips an OSC window-title-set sequence (BEL-terminated)', () => {
    expect(sanitizeTerminalText('\x1b]0;pwned\x07home')).toBe('home')
  })

  test('strips an OSC sequence terminated by ST (ESC backslash)', () => {
    expect(sanitizeTerminalText('\x1b]8;;http://evil\x1b\\link')).toBe('link')
  })

  test('strips an SGR color sequence embedded mid-string', () => {
    expect(sanitizeTerminalText('red\x1b[31mtext\x1b[0m!')).toBe('redtext!')
  })

  test('defangs a lone/unterminated ESC by dropping its introducer', () => {
    // A split or truncated sequence loses its ESC, leaving inert printable text.
    expect(sanitizeTerminalText('oops\x1b')).toBe('oops')
    expect(sanitizeTerminalText('oops\x1b[2')).toBe('oops2')
  })

  test('strips a raw C1 control byte (single-byte CSI introducer)', () => {
    expect(sanitizeTerminalText('a\x9bb')).toBe('ab')
  })

  test('strips lone C0 control bytes but preserves tab and newline', () => {
    expect(sanitizeTerminalText('a\x00\x07b\tc\nd')).toBe('ab\tc\nd')
  })

  test('leaves ordinary text untouched', () => {
    expect(sanitizeTerminalText('plain text, no escapes 123')).toBe('plain text, no escapes 123')
  })

  test('strips a run of unterminated OSC introducers without leaving an ESC', () => {
    // The OSC body is a negated class, so each bare introducer degrades via the
    // lone-ESC fallback instead of rescanning to the end (keeps the pass linear).
    const result = sanitizeTerminalText('\x1b]'.repeat(500) + 'tail')
    expect(result).toBe('tail')
  })

  // These assert the untrusted payload is gone, not the absence of all ESC: the
  // app's own color SGR (added by gray() under a TTY) is intentionally kept.
  test('flows through formatToolEnd so hostile tool output cannot spoof the terminal', () => {
    const line = formatToolEnd(false, textResult('ok\x1b]52;c;cHduZWQ=\x07'))
    expect(line).not.toContain('52;')
    expect(line).not.toContain('cHduZWQ')
    expect(line).toContain('ok')
  })

  test('flows through formatToolStart so a hostile bash command cannot spoof the terminal', () => {
    const line = formatToolStart('bash', { command: 'echo\x1b[2Jhi' })
    expect(line).not.toContain('2J')
    expect(line).toContain('echohi')
  })
})

describe('formatToolStart — argument summary', () => {
  test('bash summarizes to its command', () => {
    const line = formatToolStart('bash', { command: 'echo hi' })
    expect(line).toContain('bash')
    expect(line).toContain('echo hi')
  })

  test('renders a multiline command as one visible header line', () => {
    const line = formatToolStart('bash', { command: 'echo safe\nFAKE STATUS\tprompt' })

    expect(line).toContain('echo safe\\nFAKE STATUS\\tprompt')
    expect(line).not.toContain('\n')
    expect(line).not.toContain('\t')
  })

  test('read/write summarize to the target path', () => {
    expect(formatToolStart('read', { path: 'src/a.ts' })).toContain('src/a.ts')
  })

  test('an argument object with neither command nor path falls back to JSON', () => {
    expect(formatToolStart('weird', { foo: 'bar' })).toContain(JSON.stringify({ foo: 'bar' }))
  })

  test('a non-object argument yields a header with no summary tail', () => {
    const line = formatToolStart('read', null)
    expect(line).toContain('read')
    expect(line).not.toContain('null')
  })

  test('a long command is truncated with an ellipsis', () => {
    const line = formatToolStart('bash', { command: 'x'.repeat(500) })
    expect(line).toContain('…')
    expect(line).not.toContain('x'.repeat(500))
  })

  test('terminal width tightens the tool argument summary', () => {
    const line = formatToolStart('bash', { command: '1234567890'.repeat(8) }, 24)

    expect(line).toContain('…')
    expect(line.length).toBeLessThanOrEqual(24)
  })
})

describe('formatToolEnd — result preview', () => {
  test('a successful result shows the ok mark and a text preview', () => {
    const line = formatToolEnd(false, textResult('all good'))
    expect(line).toContain('✓')
    expect(line).toContain('all good')
    expect(line).toStartWith('  ')
  })

  test('an error result shows the fail mark', () => {
    expect(formatToolEnd(true, textResult('boom'))).toContain('✗')
  })

  test('only the first couple of result lines are previewed', () => {
    const line = formatToolEnd(false, textResult('line1\nline2\nline3\nline4'))
    expect(line).toContain('line1')
    expect(line).toContain('line2')
    expect(line).not.toContain('line3')
  })

  test('a result with no text content is just the marker', () => {
    const line = formatToolEnd(false, { content: [] })
    expect(line).toContain('✓')
    expect(line).not.toContain('undefined')
  })
})

describe('formatTurnError — error gate', () => {
  test('an errored turn returns its detail message', () => {
    const message = { stopReason: 'error', errorMessage: 'rate limited' } as unknown as AgentMessage
    const line = formatTurnError(message, 'thunderbolt')
    expect(line).toContain('rate limited')
    expect(line).toContain('retry the message — it is kept in history (↑)')
  })

  test('network and auth errors include provider-specific recovery', () => {
    const network: AgentMessage = {
      ...assistantMessage(),
      stopReason: 'error',
      errorMessage: 'network authentication unreachable',
    }
    const expired: AgentMessage = { ...assistantMessage(), stopReason: 'error', errorMessage: 'stored session expired' }
    const networkError = formatTurnError(network, 'anthropic-profile')
    const accountError = formatTurnError(expired, 'thunderbolt')
    const byokError = formatTurnError(expired, 'anthropic-profile')

    expect(networkError).toContain('check your connection — your message is kept in history (↑)')
    expect(networkError).toContain('network authentication unreachable')
    expect(accountError).toContain('Session expired')
    expect(accountError).toContain('run /login to sign in again')
    expect(byokError).toContain('Provider rejected the credential')
    expect(byokError).not.toContain('Session expired')
    expect(byokError).toContain(
      "set the provider's environment variable, pass --api-key, or repair the profile with thunderbolt config",
    )
  })

  test('an errored turn strips terminal control sequences from provider detail', () => {
    const message = {
      stopReason: 'error',
      errorMessage: 'upstream\x1b]52;c;cHduZWQ=\x07\x1b[2J failed',
    } as unknown as AgentMessage
    const line = formatTurnError(message, 'thunderbolt')

    expect(line).toContain('upstream failed')
    expect(line).not.toContain('52;')
    expect(line).not.toContain('2J')
  })

  test('an errored turn with no message uses a generic detail', () => {
    const message = { stopReason: 'error' } as unknown as AgentMessage
    expect(formatTurnError(message, 'thunderbolt')).toContain('the request failed')
  })

  test('a non-error turn returns undefined', () => {
    const message = { stopReason: 'endTurn' } as unknown as AgentMessage
    expect(formatTurnError(message, 'thunderbolt')).toBeUndefined()
  })
})
