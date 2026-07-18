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

  it('paints a committed enabled token as a quiet beige-gray badge', () => {
    // Trailing space → committed.
    const { container } = renderTokens('use /meeting-notes please')
    const span = container.querySelector('.skill-token')
    expect(span?.textContent).toBe('/meeting-notes')
    expect(span?.className).toContain('text-muted-foreground')
  })

  it('paints a committed disabled token as an amber badge', () => {
    const { container } = renderTokens('please /task-triage me')
    const span = container.querySelector('.skill-token')
    expect(span?.textContent).toBe('/task-triage')
    expect(span?.className).toContain('text-amber-700')
    expect(container.querySelector('.text-red-600')).toBeNull()
  })

  it('paints a committed unknown token as a red badge', () => {
    const { container } = renderTokens('hi /no-such-skill there')
    const span = container.querySelector('.skill-token')
    expect(span?.textContent).toBe('/no-such-skill')
    expect(span?.className).toContain('text-red-600')
  })

  it('leaves an in-progress (end-of-input, no trailing space) token unbadged even when the slug resolves', () => {
    // No trailing whitespace → in-progress; the token inherits surrounding
    // text color so the highlight doesn't flicker as the user types.
    const { container } = renderTokens('/meeting-notes')
    expect(container.querySelector('.skill-token')).toBeNull()
    expect(container.textContent).toContain('/meeting-notes')
  })

  it('leaves an in-progress unknown slug unbadged — the user is still typing', () => {
    const { container } = renderTokens('hello /partial')
    expect(container.querySelector('.skill-token')).toBeNull()
    expect(container.textContent).toContain('/partial')
  })

  it('renders a mix of statuses in one string', () => {
    const { container } = renderTokens('try /meeting-notes then /no-real next /task-triage end')
    const badges = container.querySelectorAll('.skill-token')
    expect(badges).toHaveLength(3)
    const classes = [...badges].map((b) => b.className)
    expect(classes.some((c) => c.includes('text-muted-foreground'))).toBe(true)
    expect(classes.some((c) => c.includes('text-amber-700'))).toBe(true)
    expect(classes.some((c) => c.includes('text-red-600'))).toBe(true)
  })

  it('wraps a committed unknown token in a popover trigger so the user gets a tooltip', () => {
    const { container } = renderTokens('say /unknown-slug hi')
    // The trigger span gets pointer-events-auto so it can capture hover; the
    // surrounding overlay stays pointer-events-none.
    const triggers = container.querySelectorAll('.pointer-events-auto')
    expect(triggers.length).toBeGreaterThanOrEqual(1)
  })

  it('hides the slash glyph inside committed chips (transparent, width-preserving)', () => {
    const { container } = renderTokens('use /meeting-notes please')
    const hidden = container.querySelector('.skill-token .text-transparent')
    expect(hidden?.textContent).toBe('/')
  })

  it('hides the slash of an in-progress token — the trigger is never visible while typing', () => {
    const { container } = renderTokens('hello /partial')
    const hidden = container.querySelector('.text-transparent')
    expect(hidden?.textContent).toBe('/')
  })

  it('hides a bare trailing "/" (just opened the picker, not yet a token)', () => {
    const { container } = renderTokens('hello /')
    const hidden = container.querySelector('.text-transparent')
    expect(hidden?.textContent).toBe('/')
  })

  it('hides a "/" typed as the very first character', () => {
    const { container } = renderTokens('/')
    const hidden = container.querySelector('.text-transparent')
    expect(hidden?.textContent).toBe('/')
  })

  it('keeps mid-text slashes visible (fractions, paths)', () => {
    const { container } = renderTokens('3/4 of docs/readme')
    expect(container.querySelector('.text-transparent')).toBeNull()
  })

  it('returns an array ending with a zero-width space to preserve trailing newlines', () => {
    const nodes = renderHighlightedSkillTokens('hello\n', classify)
    expect(nodes[nodes.length - 1]).toBe('​')
  })
})
