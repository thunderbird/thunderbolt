/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

import { PageCreateAction } from './page-create-action'

/** happy-dom's default viewport (matches the bun test preload). */
const desktopWidth = 1024

const setViewport = (width: number) => window.happyDOM?.setViewport({ width })

afterEach(() => {
  cleanup()
  setViewport(desktopWidth)
})

describe('PageCreateAction', () => {
  it('renders an icon-only button inline on desktop', () => {
    render(<PageCreateAction label="New Skill" onClick={() => {}} />)

    const button = screen.getByRole('button', { name: 'New Skill' })
    expect(button.textContent).toBe('')
    expect(button.closest('body > button')).toBeNull()
    expect(button).toHaveClass('-mr-2')
  })

  it('renders a labelled pill portalled to the body on mobile', () => {
    setViewport(375)
    render(<PageCreateAction label="New Skill" onClick={() => {}} />)

    const button = screen.getByRole('button', { name: 'New Skill' })
    expect(button.textContent).toContain('New Skill')
    expect(button).toHaveClass('border', 'border-border')
    // Portalled so `position: fixed` anchors to the viewport, not an ancestor.
    expect(button.parentElement).toBe(document.body)
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
