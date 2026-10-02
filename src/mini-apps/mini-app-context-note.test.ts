/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { LineChart } from 'lucide-react'
import type { MiniAppContext } from '@shared/mini-app-protocol'
import type { ThunderboltUIMessage } from '@/types'
import {
  buildMiniAppContextNote,
  supersededAppContextOutput,
  supersedeAppContextResults,
} from './mini-app-context-note'
import type { MiniAppDefinition } from './registry'

const app: MiniAppDefinition = {
  id: 'finance-model',
  name: 'Finance Model',
  description: 'Quarterly revenue model.',
  icon: LineChart,
  url: 'http://localhost:5174',
  origin: 'http://localhost:5174',
}

const context: MiniAppContext = {
  title: 'Q3 Projection',
  summary: 'Revenue of 4.2M against a 5.1M plan.',
  data: { revenue: 4_200_000, plan: 5_100_000 },
  selection: { row: 'professional-services' },
}

describe('buildMiniAppContextNote', () => {
  it('carries the title, summary and selection', () => {
    const note = buildMiniAppContextNote(app, context)
    expect(note).toContain('# Current view in Finance Model')
    expect(note).toContain('Currently viewing: Q3 Projection')
    expect(note).toContain('Revenue of 4.2M against a 5.1M plan.')
    expect(note).toContain('"row": "professional-services"')
  })

  // `data` is unbounded app state; the note is paid for on every send, so it
  // stays with the tool — and the model is told that, so "not shown" is never
  // read as "the app has no state".
  it('leaves data out and says where it went', () => {
    const note = buildMiniAppContextNote(app, context)
    expect(note).not.toContain('4200000')
    expect(note).not.toContain('Full state')
    expect(note).toContain('full underlying data is not included')
    expect(note).toContain('get_app_context')
  })

  it('tells the model this supersedes earlier tool results', () => {
    expect(buildMiniAppContextNote(app, context)).toContain('supersedes any `get_app_context` result')
  })

  it('reports an unreadable screen instead of guessing', () => {
    const note = buildMiniAppContextNote(app, null)
    expect(note).toContain('# Current view in Finance Model')
    expect(note).toContain('did not report what the user is looking at')
    expect(note).toContain('offer to try again')
  })
})

const appContextResult = (output: string) =>
  ({
    type: 'tool-get_app_context',
    toolCallId: 'call-1',
    state: 'output-available',
    input: {},
    output,
  }) as const

const otherToolResult = {
  type: 'tool-search',
  toolCallId: 'call-2',
  state: 'output-available',
  input: { query: 'x' },
  output: 'search result',
} as const

describe('supersedeAppContextResults', () => {
  it('replaces a finished get_app_context output with the placeholder', () => {
    const messages: ThunderboltUIMessage[] = [
      {
        id: 'a1',
        role: 'assistant',
        parts: [appContextResult('Currently viewing: Q2'), { type: 'text', text: 'Q2 revenue is 3.9M.' }],
      },
    ]
    const [superseded] = supersedeAppContextResults(messages)
    expect(superseded.parts[0]).toMatchObject({
      type: 'tool-get_app_context',
      toolCallId: 'call-1',
      state: 'output-available',
      output: supersededAppContextOutput,
    })
  })

  // The assistant's own prose is how "earlier you said X" keeps working.
  it('leaves text parts and other tools alone', () => {
    const messages: ThunderboltUIMessage[] = [
      {
        id: 'a1',
        role: 'assistant',
        parts: [appContextResult('Currently viewing: Q2'), otherToolResult, { type: 'text', text: 'Q2 is 3.9M.' }],
      },
    ]
    const [superseded] = supersedeAppContextResults(messages)
    expect(superseded.parts[1]).toBe(otherToolResult)
    expect(superseded.parts[2]).toEqual({ type: 'text', text: 'Q2 is 3.9M.' })
  })

  it('only rewrites finished calls', () => {
    const pending = {
      type: 'tool-get_app_context',
      toolCallId: 'call-3',
      state: 'input-available',
      input: {},
    } as const
    const messages: ThunderboltUIMessage[] = [{ id: 'a1', role: 'assistant', parts: [pending] }]
    expect(supersedeAppContextResults(messages)[0]).toBe(messages[0])
  })

  it('returns untouched messages by identity', () => {
    const messages: ThunderboltUIMessage[] = [
      { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'hi' }] },
      { id: 'a1', role: 'assistant', parts: [otherToolResult] },
    ]
    const result = supersedeAppContextResults(messages)
    expect(result[0]).toBe(messages[0])
    expect(result[1]).toBe(messages[1])
  })
})
