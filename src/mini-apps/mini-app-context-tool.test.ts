/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { LineChart } from 'lucide-react'
import { maxContextPayloadChars, type MiniAppContext } from '@shared/mini-app-protocol'
import { formatMiniAppContext } from './mini-app-context-tool'
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

describe('formatMiniAppContext', () => {
  it('leads with the title and the app-authored summary', () => {
    const output = formatMiniAppContext(app, context)
    expect(output).toContain('Currently viewing: Q3 Projection')
    expect(output).toContain('Revenue of 4.2M against a 5.1M plan.')
  })

  it('serializes selection and data so the model can quote exact figures', () => {
    const output = formatMiniAppContext(app, context)
    expect(output).toContain('professional-services')
    expect(output).toContain('4200000')
  })

  it('omits selection and data sections when the app sends neither', () => {
    const output = formatMiniAppContext(app, { title: 'Empty', summary: 'Nothing selected.' })
    expect(output).not.toContain('Selected:')
    expect(output).not.toContain('Full state:')
  })

  // An app that hasn't published yet is the most likely demo failure. Saying so
  // beats the model inventing plausible numbers.
  it('tells the model the view is empty rather than letting it guess', () => {
    const output = formatMiniAppContext(app, null)
    expect(output).toContain("hasn't reported any state")
    expect(output).toContain('Finance Model')
  })

  it('handles falsy-but-present data without dropping it', () => {
    const output = formatMiniAppContext(app, { title: 't', summary: 's', data: 0, selection: false })
    expect(output).toContain('Selected:')
    expect(output).toContain('Full state:')
  })

  /**
   * `data` is the one guest field with no schema bound — it has to stay
   * arbitrary structure — so the ceiling lives here, where it would otherwise
   * reach the model verbatim on every read.
   */
  it('withholds a data payload larger than the ceiling, and says so', () => {
    const huge = { blob: 'x'.repeat(maxContextPayloadChars * 2) }
    const output = formatMiniAppContext(app, { title: 'Big', summary: 'A large model.', data: huge })

    expect(output).not.toContain('xxxxxxxxxx')
    expect(output).toContain('withheld')
    expect(output).toContain(`over the ${maxContextPayloadChars}-character limit`)
    // The prose the author wrote for the model survives the payload being dropped.
    expect(output).toContain('A large model.')
  })

  it('applies the same ceiling to selection', () => {
    const huge = { blob: 'x'.repeat(maxContextPayloadChars * 2) }
    const output = formatMiniAppContext(app, { title: 'Big', summary: 's', selection: huge })

    expect(output).toContain('Selected: withheld')
    expect(output).not.toContain('xxxxxxxxxx')
  })

  it('keeps a payload that sits just under the ceiling', () => {
    const snug = 'y'.repeat(maxContextPayloadChars - 100)
    const output = formatMiniAppContext(app, { title: 'Snug', summary: 's', data: snug })

    expect(output).toContain('Full state:')
    expect(output).toContain(snug)
  })

  /** `postMessage` clones with structured clone, which carries cycles that
   *  `JSON.stringify` throws on — so the app really can hand us one. */
  it('reports an unserialisable payload instead of throwing', () => {
    const cyclic: Record<string, unknown> = { name: 'loop' }
    cyclic.self = cyclic

    const output = formatMiniAppContext(app, { title: 'Cyclic', summary: 'Still readable.', data: cyclic })

    expect(output).toContain('could not be serialised')
    expect(output).toContain('Still readable.')
  })
})
