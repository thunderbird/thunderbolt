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
import { formatToolEnd, formatToolStart, formatTurnError } from './render.ts'

/** A Pi tool result carrying a single text content block. */
const textResult = (text: string): unknown => ({ content: [{ type: 'text', text }] })

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

  test('an errored turn with no message uses a generic detail', () => {
    const message = { stopReason: 'error' } as unknown as AgentMessage
    expect(formatTurnError(message)).toContain('the request failed')
  })

  test('a non-error turn returns undefined', () => {
    const message = { stopReason: 'endTurn' } as unknown as AgentMessage
    expect(formatTurnError(message)).toBeUndefined()
  })
})
