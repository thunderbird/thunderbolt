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

import type { AgentMessage } from '@earendil-works/pi-agent-core'
import { describe, expect, test } from 'bun:test'
import { formatToolEnd, formatToolStart, formatTurnError, sanitizeTerminalText } from './render.ts'

/** A Pi tool result carrying a single text content block. */
const textResult = (text: string): unknown => ({ content: [{ type: 'text', text }] })

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
})

describe('formatToolEnd — result preview', () => {
  test('a successful result shows the ok mark and a text preview', () => {
    const line = formatToolEnd(false, textResult('all good'))
    expect(line).toContain('✓')
    expect(line).toContain('all good')
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
    expect(formatTurnError(message)).toContain('rate limited')
  })

  test('an errored turn strips terminal control sequences from provider detail', () => {
    const message = {
      stopReason: 'error',
      errorMessage: 'upstream\x1b]52;c;cHduZWQ=\x07\x1b[2J failed',
    } as unknown as AgentMessage
    const line = formatTurnError(message)

    expect(line).toContain('upstream failed')
    expect(line).not.toContain('52;')
    expect(line).not.toContain('2J')
  })

  test('an errored turn with no message uses a generic detail', () => {
    const message = { stopReason: 'error' } as unknown as AgentMessage
    expect(formatTurnError(message)).toContain('the request failed')
  })

  test('a non-error turn returns undefined', () => {
    const message = { stopReason: 'endTurn' } as unknown as AgentMessage
    expect(formatTurnError(message)).toBeUndefined()
  })
})
