/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { render } from '@testing-library/react'
import { TooltipProvider } from '@/components/ui/tooltip'

import { renderHighlightedSkillTokens } from './highlight-skill-tokens'

const renderInTooltipProvider = (nodes: ReturnType<typeof renderHighlightedSkillTokens>) =>
  render(<TooltipProvider>{nodes}</TooltipProvider>)

const isValid = (slug: string) => slug === 'meeting-notes' || slug === 'weekly-review'

describe('renderHighlightedSkillTokens', () => {
  it('renders plain text unchanged when no tokens are present', () => {
    const { container } = renderInTooltipProvider(renderHighlightedSkillTokens('just a message', isValid))
    expect(container.textContent).toContain('just a message')
  })

  it('wraps a resolved token in the sky-toned highlight span', () => {
    const { container } = renderInTooltipProvider(renderHighlightedSkillTokens('use /meeting-notes please', isValid))
    const span = container.querySelector('.text-sky-500')
    expect(span?.textContent).toBe('/meeting-notes')
  })

  it('wraps an unresolved token in the orange highlight span', () => {
    const { container } = renderInTooltipProvider(renderHighlightedSkillTokens('hi /unknown there', isValid))
    const span = container.querySelector('.text-orange-500')
    expect(span?.textContent).toBe('/unknown')
  })

  it('renders both resolved and unresolved tokens in a single string', () => {
    const { container } = renderInTooltipProvider(
      renderHighlightedSkillTokens('try /meeting-notes then /unknown next /weekly-review', isValid),
    )
    expect(container.querySelectorAll('.text-sky-500')).toHaveLength(2)
    expect(container.querySelectorAll('.text-orange-500')).toHaveLength(1)
  })

  it('returns an array ending with a zero-width space to preserve trailing newlines', () => {
    const nodes = renderHighlightedSkillTokens('hello\n', isValid)
    expect(nodes[nodes.length - 1]).toBe('​')
  })
})
