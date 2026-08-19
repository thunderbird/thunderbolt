/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { LineChart } from 'lucide-react'
import type { MiniAppContext } from '@shared/mini-app-protocol'
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
})
