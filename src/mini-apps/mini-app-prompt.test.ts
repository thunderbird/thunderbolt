/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { LineChart } from 'lucide-react'
import { buildMiniAppPromptSection } from './mini-app-prompt'
import type { MiniAppDefinition } from './registry'

const app: MiniAppDefinition = {
  id: 'finance-model',
  name: 'Finance Model',
  description: 'Quarterly revenue and headcount model.',
  icon: LineChart,
  url: 'http://localhost:5174',
  origin: 'http://localhost:5174',
}

describe('buildMiniAppPromptSection', () => {
  it('returns null when no app is open, so the prompt gains no empty heading', () => {
    expect(buildMiniAppPromptSection(null)).toBeNull()
  })

  it('names the app and its purpose', () => {
    const section = buildMiniAppPromptSection(app)
    expect(section).toContain('# Mini App: Finance Model')
    expect(section).toContain('Quarterly revenue and headcount model.')
  })

  // Without an explicit pointer the model answers "I can't see your screen"
  // instead of calling the tool.
  it('tells the model to call get_app_context', () => {
    expect(buildMiniAppPromptSection(app)).toContain('get_app_context')
  })

  /*
   * The load-bearing property of this section: it lands in the *stable*,
   * cacheable half of the system prompt, so it must depend only on the app's
   * identity. If live state ever leaks in here, the prompt cache is invalidated
   * on every click — the exact trade `project-search-tool.ts` documents.
   */
  it('is stable across calls for the same app', () => {
    expect(buildMiniAppPromptSection(app)).toBe(buildMiniAppPromptSection(app))
  })
})
