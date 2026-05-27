/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterEach, describe, expect, it } from 'bun:test'
import { cleanup, render } from '@testing-library/react'
import { MemoryRouter } from 'react-router'

import { SkillTokenPopover } from './skill-token-popover'

// HoverCard's open/close behavior depends on timer-driven hover handling
// inside Radix and JSDOM-incompatible pointer events. We assert the
// trigger surface that the chat composer relies on, not the full
// open/close cycle — that lives in manual / e2e testing.
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

  it('exposes the trigger as keyboard-focusable so users can Tab to a problematic token', () => {
    const { container } = renderPopover({ editSkill: 'id-1' })
    const trigger = container.querySelector('[tabindex="0"]')
    expect(trigger?.textContent).toBe('/some-token')
  })
})
