/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

import { forceMobileViewport, restoreViewport } from '@/test-utils/viewport'
import { PageCreateAction } from './page-create-action'

afterEach(() => {
  cleanup()
  restoreViewport()
})

describe('PageCreateAction', () => {
  it('renders an icon-only button inline on desktop', () => {
    render(<PageCreateAction label="New Skill" onClick={() => {}} />)

    const button = screen.getByRole('button', { name: 'New Skill' })
    expect(button.textContent).toBe('')
    expect(button.closest('body > button')).toBeNull()
    expect(button).toHaveClass('-mr-2', 'border', 'bg-card')
  })

  it('renders a labelled pill portaled to the body on mobile', () => {
    forceMobileViewport()
    render(<PageCreateAction label="New Skill" onClick={() => {}} />)

    const button = screen.getByRole('button', { name: 'New Skill' })
    expect(button.textContent).toContain('New Skill')
    // Borderless like the sidebar's mobile New Chat pill it mirrors.
    expect(button).toHaveClass('rounded-full', 'border-none')
    // Portaled so `position: fixed` anchors to the viewport, not an ancestor.
    expect(button.parentElement).toBe(document.body)
    expect(document.querySelector('[data-slot="page-create-action-scrim"]')).toHaveClass('fixed', 'z-20')
  })

  it('forwards clicks and the disabled state in both layouts', () => {
    const onClick = mock()
    const { rerender } = render(<PageCreateAction label="New Task" onClick={onClick} />)
    fireEvent.click(screen.getByRole('button', { name: 'New Task' }))
    expect(onClick).toHaveBeenCalledTimes(1)

    rerender(<PageCreateAction label="New Task" onClick={onClick} disabled />)
    expect(screen.getByRole('button', { name: 'New Task' })).toBeDisabled()
  })
})
