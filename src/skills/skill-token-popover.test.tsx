/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterEach, describe, expect, it } from 'bun:test'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'

import { SkillTokenPopover } from './skill-token-popover'

const renderPopover = (state: { editSkill: string } | { createSkill: string }) =>
  render(
    <MemoryRouter>
      <SkillTokenPopover
        trigger={<span className="text-orange-500">/some-token</span>}
        message="Skill is broken."
        actionLabel="Enable"
        state={state}
      />
    </MemoryRouter>,
  )

describe('SkillTokenPopover', () => {
  afterEach(cleanup)

  it('renders the trigger with pointer-events-auto so it can capture hover inside a pointer-events-none overlay', () => {
    const { container } = renderPopover({ editSkill: 'id-1' })
    const trigger = container.querySelector('.pointer-events-auto')
    expect(trigger).toBeTruthy()
    expect(trigger?.textContent).toBe('/some-token')
  })

  it('opens on mouse-enter and renders the message + action link', () => {
    renderPopover({ editSkill: 'id-1' })
    const trigger = screen.getByText('/some-token')
    fireEvent.mouseEnter(trigger)
    // Popover content is portaled — query by role-agnostic text in the document.
    expect(screen.getByText('Skill is broken.')).toBeTruthy()
    const link = screen.getByText('Enable') as HTMLAnchorElement
    expect(link.tagName).toBe('A')
    expect(link.getAttribute('href')).toBe('/settings/skills')
  })

  it('stays open when the cursor moves from the trigger into the popover content', () => {
    renderPopover({ createSkill: 'no-such-slug' })
    const trigger = screen.getByText('/some-token')
    fireEvent.mouseEnter(trigger)
    fireEvent.mouseLeave(trigger)
    // Move into the content before the close-delay fires.
    const message = screen.getByText('Skill is broken.')
    fireEvent.mouseEnter(message)
    // Content still mounted because cancelClose() fired.
    expect(screen.getByText('Skill is broken.')).toBeTruthy()
  })
})
