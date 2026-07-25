/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import '@testing-library/jest-dom'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, mock } from 'bun:test'

import { MobileCardMenu } from './mobile-card-menu'

afterEach(cleanup)

describe('MobileCardMenu', () => {
  it('renders a full-width bottom drawer with an accessible title', () => {
    render(
      <MobileCardMenu open onOpenChange={() => {}} title="Choose model">
        <button type="button">Model one</button>
      </MobileCardMenu>,
    )

    const drawer = screen.getByText('Choose model').closest('[data-slot="drawer-content"]')
    expect(drawer).toHaveClass('w-full')
    expect(drawer).toHaveClass('bg-popover/80', 'backdrop-blur-lg')
    expect(drawer).toHaveClass('data-[vaul-drawer-direction=bottom]:rounded-t-3xl')
    expect(drawer).toHaveAttribute('data-vaul-drawer-direction', 'bottom')
    expect(document.querySelector('[data-slot="drawer-handle"]')).toHaveClass(
      '!h-1',
      '!w-10',
      '!bg-muted-foreground/10',
      'dark:!bg-white/5',
    )
  })

  it('supports a top drawer and keyboard dismissal', () => {
    const onOpenChange = mock<(open: boolean) => void>(() => {})
    render(
      <MobileCardMenu open onOpenChange={onOpenChange} title="Choose agent" side="top">
        Agent one
      </MobileCardMenu>,
    )

    const drawer = screen.getByText('Choose agent').closest('[data-slot="drawer-content"]')
    expect(drawer).toHaveAttribute('data-vaul-drawer-direction', 'top')
    expect(drawer).toHaveClass('data-[vaul-drawer-direction=top]:rounded-b-3xl')

    const overlay = document.querySelector('[data-slot="drawer-overlay"]')
    expect(overlay).toBeInTheDocument()
    expect(overlay).toHaveClass('backdrop-blur-sm', 'max-md:backdrop-saturate-75')
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })
})
