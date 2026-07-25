/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Drawer as DrawerPrimitive } from '@base-ui/react/drawer'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, mock } from 'bun:test'
import { useState, type ReactNode } from 'react'

import '@/test-utils/framer-motion-mock'
import { getClock } from '@/testing-library'
import { MobileSidebar, shouldOpenMobileSidebar } from './mobile-sidebar'

/** Controlled wrapper mirroring how `Sidebar` drives the drawer (open is parent-owned). */
const Harness = ({
  enabled = true,
  initiallyOpen = true,
  onOpenChange,
  onCloseComplete,
  mainContent = <button type="button">main content</button>,
}: {
  enabled?: boolean
  initiallyOpen?: boolean
  onOpenChange: (open: boolean) => void
  onCloseComplete?: () => void
  mainContent?: ReactNode
}) => {
  const [open, setOpen] = useState(initiallyOpen)
  return (
    <MobileSidebar
      enabled={enabled}
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        onOpenChange(next)
      }}
      onCloseComplete={onCloseComplete}
      sidebar={<nav aria-label="Primary navigation">sidebar content</nav>}
    >
      {mainContent}
    </MobileSidebar>
  )
}

const getSidebar = () => document.querySelector('[data-slot="sidebar"]')!
const getMain = () => document.querySelector('[data-slot="sidebar-main"]')!
const getCloseSurface = () => document.querySelector('[data-sidebar-drag-surface]')!

const flushAnimations = async () => {
  await act(async () => {
    await getClock().runAllAsync()
  })
}

describe('MobileSidebar', () => {
  it('layers an accessible stationary menu beneath the foreground', () => {
    render(<Harness onOpenChange={() => {}} />)

    expect(screen.getByRole('dialog', { name: 'Navigation' })).toBeInTheDocument()
    expect(getSidebar()).toHaveClass('bg-sidebar/80', 'backdrop-blur-lg')
    expect(getSidebar()).not.toHaveClass('shadow-lg')
    expect(getSidebar()).toHaveAttribute('data-swipe-direction', 'left')
    expect(getMain()).toHaveClass('mobile-sidebar-main', 'bg-background', 'mobile-sidebar-main-shadow')
    expect(getMain().firstElementChild).toHaveAttribute('inert')
    expect(getCloseSurface()).toHaveClass('bg-transparent', 'pointer-events-auto')
  })

  it('configures the whole foreground for direction-locked horizontal dragging', () => {
    render(<Harness initiallyOpen={false} onOpenChange={() => {}} />)

    expect(getMain()).toHaveStyle('touch-action: pan-y')
    expect(getMain().firstElementChild).toHaveClass('flex', 'h-full', 'flex-1', 'flex-col')
    expect(getMain().firstElementChild).not.toHaveAttribute('inert')
    expect(screen.getByRole('button', { name: 'main content' })).toBeInTheDocument()
  })

  it('keeps nested card drawers independent from mobile navigation', () => {
    render(
      <Harness
        initiallyOpen={false}
        onOpenChange={() => {}}
        mainContent={
          <DrawerPrimitive.Root open>
            <DrawerPrimitive.Portal>
              <DrawerPrimitive.Backdrop data-slot="nested-card-backdrop" />
              <DrawerPrimitive.Viewport>
                <DrawerPrimitive.Popup data-slot="nested-card">
                  <DrawerPrimitive.Title>Agent selector</DrawerPrimitive.Title>
                  <DrawerPrimitive.Content>card content</DrawerPrimitive.Content>
                </DrawerPrimitive.Popup>
              </DrawerPrimitive.Viewport>
            </DrawerPrimitive.Portal>
          </DrawerPrimitive.Root>
        }
      />,
    )

    const card = screen.getByRole('dialog', { name: 'Agent selector' })
    expect(card).not.toHaveAttribute('data-nested')
    expect(document.querySelector('[data-slot="nested-card-backdrop"]')).toBeVisible()
    expect(screen.queryByRole('dialog', { name: 'Navigation' })).not.toBeInTheDocument()
  })

  it('chooses the resting side from distance and release velocity', () => {
    expect(shouldOpenMobileSidebar(160, 300, 0)).toBe(true)
    expect(shouldOpenMobileSidebar(140, 300, 0)).toBe(false)
    expect(shouldOpenMobileSidebar(20, 300, 600)).toBe(true)
    expect(shouldOpenMobileSidebar(280, 300, -600)).toBe(false)
  })

  it('closes from the exposed foreground surface', async () => {
    const onOpenChange = mock()
    render(<Harness onOpenChange={onOpenChange} />)

    fireEvent.click(getCloseSurface())
    fireEvent.click(getCloseSurface())
    await flushAnimations()

    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(onOpenChange).toHaveBeenCalledTimes(1)
  })

  it('supports Escape dismissal and reports when closing settles', async () => {
    const onOpenChange = mock()
    const onCloseComplete = mock()
    render(<Harness onOpenChange={onOpenChange} onCloseComplete={onCloseComplete} />)

    fireEvent.keyDown(document, { key: 'Escape' })
    await flushAnimations()

    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(onCloseComplete).toHaveBeenCalledTimes(1)
  })

  it('provides a portal inside the movable foreground', () => {
    render(<Harness initiallyOpen={false} onOpenChange={() => {}} />)

    expect(getMain().querySelector('[data-slot="mobile-foreground-portal"]')).toBeInTheDocument()
  })

  it('preserves the foreground subtree across the mobile breakpoint', () => {
    const renderSidebar = (enabled: boolean) => (
      <MobileSidebar
        enabled={enabled}
        open={false}
        onOpenChange={() => {}}
        sidebar={<nav aria-label="Primary navigation">sidebar content</nav>}
      >
        <input aria-label="Draft" defaultValue="unchanged" />
      </MobileSidebar>
    )
    const { rerender } = render(renderSidebar(true))
    const input = screen.getByRole('textbox', { name: 'Draft' })

    rerender(renderSidebar(false))

    expect(screen.getByRole('textbox', { name: 'Draft' })).toBe(input)
    expect(getMain()).toHaveStyle('touch-action: auto')
    expect(screen.getByRole('navigation', { name: 'Primary navigation' })).toBeInTheDocument()
  })
})
