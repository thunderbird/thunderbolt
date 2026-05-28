/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { render } from '@testing-library/react'
import { MemoryRouter } from 'react-router'

import { renderHighlightedSkillTokens, type SkillStatusClassifier } from './highlight-skill-tokens'

const classify: SkillStatusClassifier = (slug) => {
  if (slug === 'meeting-notes') {
    return { status: 'enabled', skillId: 'id-meeting' }
  }
  if (slug === 'weekly-review') {
    return { status: 'enabled', skillId: 'id-weekly' }
  }
  if (slug === 'task-triage') {
    return { status: 'disabled', skillId: 'id-triage' }
  }
  return { status: 'unknown' }
}

const renderTokens = (text: string) =>
  render(<MemoryRouter>{renderHighlightedSkillTokens(text, classify)}</MemoryRouter>)

describe('renderHighlightedSkillTokens', () => {
  it('renders plain text unchanged when no tokens are present', () => {
    const { container } = renderTokens('just a message')
    expect(container.textContent).toContain('just a message')
  })

  it('paints a committed enabled token blue (sky)', () => {
    // Trailing space → committed.
    const { container } = renderTokens('use /meeting-notes please')
    const span = container.querySelector('.text-sky-500')
    expect(span?.textContent).toBe('/meeting-notes')
  })

  it('paints a committed disabled token orange', () => {
    const { container } = renderTokens('please /task-triage me')
    const span = container.querySelector('.text-orange-500')
    expect(span?.textContent).toBe('/task-triage')
    expect(container.querySelector('.text-red-500')).toBeNull()
    expect(container.querySelector('.text-sky-500')).toBeNull()
  })

  it('paints a committed unknown token red', () => {
    const { container } = renderTokens('hi /no-such-skill there')
    const span = container.querySelector('.text-red-500')
    expect(span?.textContent).toBe('/no-such-skill')
  })

  it('paints an in-progress (end-of-input, no trailing space) token orange even when the slug resolves', () => {
    // No trailing whitespace → in-progress regardless of resolution status.
    const { container } = renderTokens('/meeting-notes')
    expect(container.querySelector('.text-sky-500')).toBeNull()
    expect(container.querySelector('.text-orange-500')?.textContent).toBe('/meeting-notes')
  })

  it('paints in-progress orange even for an unknown slug — the user is still typing', () => {
    const { container } = renderTokens('hello /partial')
    expect(container.querySelector('.text-red-500')).toBeNull()
    expect(container.querySelector('.text-orange-500')?.textContent).toBe('/partial')
  })

  it('renders a mix of statuses in one string', () => {
    const { container } = renderTokens('try /meeting-notes then /no-real next /task-triage end')
    expect(container.querySelectorAll('.text-sky-500')).toHaveLength(1)
    expect(container.querySelectorAll('.text-orange-500')).toHaveLength(1)
    expect(container.querySelectorAll('.text-red-500')).toHaveLength(1)
  })

  it('wraps a committed unknown token in a popover trigger so the user gets a tooltip', () => {
    const { container } = renderTokens('say /unknown-slug hi')
    // The trigger span gets pointer-events-auto so it can capture hover; the
    // surrounding overlay stays pointer-events-none.
    const triggers = container.querySelectorAll('.pointer-events-auto')
    expect(triggers.length).toBeGreaterThanOrEqual(1)
  })

  it('returns an array ending with a zero-width space to preserve trailing newlines', () => {
    const nodes = renderHighlightedSkillTokens('hello\n', classify)
    expect(nodes[nodes.length - 1]).toBe('​')
  })
})
