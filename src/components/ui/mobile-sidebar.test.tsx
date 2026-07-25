/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Drawer as DrawerPrimitive } from '@base-ui/react/drawer'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, mock } from 'bun:test'
import { useState, type ReactNode } from 'react'

import '@/test-utils/framer-motion-mock'
import { getClock } from '@/testing-library'
import {
  canStartSidebarDrag,
  hasHorizontalScrollAncestor,
  MobileSidebar,
  shouldNotifyMobileSidebarClose,
  shouldOpenMobileSidebar,
} from './mobile-sidebar'

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

const getSidebar = () => document.querySelector<HTMLElement>('[data-slot="sidebar"]')!
const getMain = () => document.querySelector<HTMLElement>('[data-slot="sidebar-main"]')!
const getCloseSurface = () => document.querySelector<HTMLElement>('[data-sidebar-drag-surface]')!

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
    expect(getSidebar().style.getPropertyValue('--mobile-sidebar-footer-inset')).not.toBe('')
    expect(getSidebar()).toHaveAttribute('data-swipe-direction', 'left')
    expect(getMain()).toHaveClass('bg-background', 'mobile-sidebar-main-shadow')
    expect(getMain().firstElementChild).toHaveAttribute('inert')
    expect(getCloseSurface()).toHaveClass('bg-transparent', 'pointer-events-auto')
    expect(screen.getByRole('navigation', { name: 'Primary navigation' }).parentElement).toHaveClass('flex', 'h-full')
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

  it('reports close settlement only for a real or externally pending close', () => {
    expect(shouldNotifyMobileSidebarClose(true, false, false)).toBe(true)
    expect(shouldNotifyMobileSidebarClose(false, false, true)).toBe(true)
    expect(shouldNotifyMobileSidebarClose(false, false, false)).toBe(false)
    expect(shouldNotifyMobileSidebarClose(true, true, true)).toBe(false)
  })

  it('decides drag eligibility from the touched element', () => {
    const boundary = document.createElement('div')
    document.body.appendChild(boundary)
    try {
      const plain = boundary.appendChild(document.createElement('p'))
      expect(canStartSidebarDrag(plain, boundary)).toBe(true)

      const button = boundary.appendChild(document.createElement('button'))
      expect(canStartSidebarDrag(button, boundary)).toBe(false)

      // The dedicated close surface always drags, even though it is a button.
      const closeSurface = boundary.appendChild(document.createElement('button'))
      closeSurface.setAttribute('data-sidebar-drag-surface', '')
      expect(canStartSidebarDrag(closeSurface, boundary)).toBe(true)

      expect(canStartSidebarDrag(null, boundary)).toBe(false)
    } finally {
      boundary.remove()
    }
  })

  it('leaves nested horizontal scrollers their native swipe', () => {
    const boundary = document.createElement('div')
    document.body.appendChild(boundary)
    try {
      const scroller = boundary.appendChild(document.createElement('div'))
      scroller.style.overflowX = 'auto'
      Object.defineProperty(scroller, 'scrollWidth', { value: 200 })
      Object.defineProperty(scroller, 'clientWidth', { value: 100 })
      const chip = scroller.appendChild(document.createElement('span'))

      expect(hasHorizontalScrollAncestor(chip, boundary)).toBe(true)
      expect(canStartSidebarDrag(chip, boundary)).toBe(false)

      const outside = boundary.appendChild(document.createElement('span'))
      expect(hasHorizontalScrollAncestor(outside, boundary)).toBe(false)
      expect(canStartSidebarDrag(outside, boundary)).toBe(true)
    } finally {
      boundary.remove()
    }
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

  it('cancels an in-flight close when reopened before it settles', async () => {
    const onCloseComplete = mock()
    const onCloseCancel = mock()
    const view = (open: boolean) => (
      <MobileSidebar
        enabled
        open={open}
        onOpenChange={() => {}}
        onCloseComplete={onCloseComplete}
        onCloseCancel={onCloseCancel}
        sidebar={<nav aria-label="Primary navigation">sidebar content</nav>}
      >
        <button type="button">main content</button>
      </MobileSidebar>
    )
    const { rerender } = render(view(true))

    // Reopen synchronously, before the close animation's finish settles.
    rerender(view(false))
    rerender(view(true))
    await flushAnimations()

    expect(onCloseCancel).toHaveBeenCalledTimes(1)
    expect(onCloseComplete).not.toHaveBeenCalled()
  })

  it('keeps the sidebar subtree mounted after closing', async () => {
    render(<Harness onOpenChange={() => {}} />)
    const sidebarContent = screen.getByRole('navigation', { name: 'Primary navigation' })

    fireEvent.keyDown(document, { key: 'Escape' })
    await flushAnimations()

    expect(sidebarContent).toBeInTheDocument()
    expect(sidebarContent.closest('[role="presentation"]')).toHaveAttribute('hidden')
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
