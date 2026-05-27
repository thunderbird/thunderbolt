/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { render } from '@testing-library/react'

import { renderHighlightedSkillTokens, type SkillStatusClassifier } from './highlight-skill-tokens'

const classify: SkillStatusClassifier = (slug) => {
  if (slug === 'meeting-notes' || slug === 'weekly-review') {
    return 'enabled'
  }
  if (slug === 'task-triage') {
    return 'disabled'
  }
  return 'unknown'
}

describe('renderHighlightedSkillTokens', () => {
  it('renders plain text unchanged when no tokens are present', () => {
    const { container } = render(<>{renderHighlightedSkillTokens('just a message', classify)}</>)
    expect(container.textContent).toContain('just a message')
  })

  it('paints a committed enabled token blue (sky)', () => {
    // Trailing space → committed.
    const { container } = render(<>{renderHighlightedSkillTokens('use /meeting-notes please', classify)}</>)
    const span = container.querySelector('.text-sky-500')
    expect(span?.textContent).toBe('/meeting-notes')
  })

  it('paints a committed disabled token orange', () => {
    const { container } = render(<>{renderHighlightedSkillTokens('please /task-triage me', classify)}</>)
    const span = container.querySelector('.text-orange-500')
    expect(span?.textContent).toBe('/task-triage')
    expect(container.querySelector('.text-red-500')).toBeNull()
    expect(container.querySelector('.text-sky-500')).toBeNull()
  })

  it('paints a committed unknown token red', () => {
    const { container } = render(<>{renderHighlightedSkillTokens('hi /no-such-skill there', classify)}</>)
    const span = container.querySelector('.text-red-500')
    expect(span?.textContent).toBe('/no-such-skill')
  })

  it('paints an in-progress (end-of-input, no trailing space) token orange even when the slug resolves', () => {
    // No trailing whitespace → in-progress regardless of resolution status.
    const { container } = render(<>{renderHighlightedSkillTokens('/meeting-notes', classify)}</>)
    expect(container.querySelector('.text-sky-500')).toBeNull()
    expect(container.querySelector('.text-orange-500')?.textContent).toBe('/meeting-notes')
  })

  it('paints in-progress orange even for an unknown slug — the user is still typing', () => {
    const { container } = render(<>{renderHighlightedSkillTokens('hello /partial', classify)}</>)
    expect(container.querySelector('.text-red-500')).toBeNull()
    expect(container.querySelector('.text-orange-500')?.textContent).toBe('/partial')
  })

  it('renders a mix of statuses in one string', () => {
    const { container } = render(
      <>{renderHighlightedSkillTokens('try /meeting-notes then /no-real next /task-triage end', classify)}</>,
    )
    expect(container.querySelectorAll('.text-sky-500')).toHaveLength(1)
    expect(container.querySelectorAll('.text-orange-500')).toHaveLength(1)
    expect(container.querySelectorAll('.text-red-500')).toHaveLength(1)
  })

  it('returns an array ending with a zero-width space to preserve trailing newlines', () => {
    const nodes = renderHighlightedSkillTokens('hello\n', classify)
    expect(nodes[nodes.length - 1]).toBe('​')
  })
})
