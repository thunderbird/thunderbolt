/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Registers the framer-motion `mock.module` (side effect) so `animate` resolves
// synchronously and `useMotionValue`/`useDragControls` return inert values. The
// named import also lets tests assert on the animations the component starts.
import { animateSpy } from '@/test-utils/framer-motion-mock'

import { Drawer as DrawerPrimitive } from '@base-ui/react/drawer'
import { act, fireEvent, render, renderHook, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, mock } from 'bun:test'
import type { PanInfo } from 'framer-motion'
import { useState, type ReactNode } from 'react'

import { HapticsProvider } from '@/hooks/use-haptics'
import { useLocalSettingsStore } from '@/stores/local-settings-store'
import { getClock, webHapticsTriggerMock } from '@/testing-library'

// Import the module under test dynamically — after the framer-motion mock above
// has registered — so the shared `mock.module('framer-motion')` intercepts its
// imports. A top-level static import links the real framer-motion before the
// mock applies, which would leave `animateSpy` empty and silently run the suite
// against the real animation runtime (see framer-motion-mock.ts).
const {
  canStartSidebarDrag,
  isInHorizontalScroller,
  MobileSidebar,
  shouldNotifyMobileSidebarClose,
  shouldOpenMobileSidebar,
  useMobileSidebarState,
} = await import('./mobile-sidebar')

beforeEach(() => {
  animateSpy.mockClear()
})

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
    expect(getMain().firstElementChild).toHaveStyle('--kb: 0px')
    expect(getCloseSurface()).toHaveClass('bg-transparent', 'pointer-events-auto')
    expect(screen.getByRole('navigation', { name: 'Primary navigation' }).parentElement).toHaveClass('flex', 'h-full')
  })

  it('configures the whole foreground for direction-locked horizontal dragging', () => {
    render(<Harness initiallyOpen={false} onOpenChange={() => {}} />)

    expect(getMain()).toHaveStyle('touch-action: pan-y')
    expect(getMain().firstElementChild).toHaveClass('flex', 'h-full', 'flex-1', 'flex-col')
    expect(getMain().firstElementChild).not.toHaveAttribute('inert')
    expect((getMain().firstElementChild as HTMLElement).style.getPropertyValue('--kb')).toBe('')
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

  it('leaves horizontal scrollers and their contents their native swipe', () => {
    const boundary = document.createElement('div')
    document.body.appendChild(boundary)
    try {
      const scroller = boundary.appendChild(document.createElement('div'))
      scroller.style.overflowX = 'auto'
      Object.defineProperty(scroller, 'scrollWidth', { value: 200 })
      Object.defineProperty(scroller, 'clientWidth', { value: 100 })
      const chip = scroller.appendChild(document.createElement('span'))

      // Matches the scroller itself and elements nested inside it.
      expect(isInHorizontalScroller(scroller, boundary)).toBe(true)
      expect(isInHorizontalScroller(chip, boundary)).toBe(true)
      expect(canStartSidebarDrag(chip, boundary)).toBe(false)

      const outside = boundary.appendChild(document.createElement('span'))
      expect(isInHorizontalScroller(outside, boundary)).toBe(false)
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
    expect(getMain().firstElementChild).toHaveStyle('--kb: 0px')
    await flushAnimations()

    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(onOpenChange).toHaveBeenCalledTimes(1)
    expect((getMain().firstElementChild as HTMLElement).style.getPropertyValue('--kb')).toBe('')
  })

  it('supports Escape dismissal and reports when closing settles', async () => {
    const onOpenChange = mock()
    const onCloseComplete = mock()
    render(<Harness onOpenChange={onOpenChange} onCloseComplete={onCloseComplete} />)

    fireEvent.keyDown(document, { key: 'Escape' })
    await flushAnimations()

    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(onCloseComplete).toHaveBeenCalledTimes(1)
    // Sanity check that the framer-motion mock is intercepting this suite: the
    // close must have run through the mocked `animate`. If this fails, the
    // dynamic import above stopped shielding the mock (see framer-motion-mock.ts).
    expect(animateSpy).toHaveBeenCalled()
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

const makeDragInfo = (velocityX: number): PanInfo => ({
  point: { x: 0, y: 0 },
  delta: { x: 0, y: 0 },
  offset: { x: 0, y: 0 },
  velocity: { x: velocityX, y: 0 },
})

const dragEndEvent = () => new MouseEvent('pointerup')

/**
 * Drives `useMobileSidebarState` directly: framer-motion's drag callbacks
 * cannot be produced through the DOM in tests, so the hook's handlers are
 * invoked with synthetic PanInfo. Mirrors the controlled parent: `open` round-
 * trips through `onOpenChange`, and `setOpen` stands in for an external
 * `closeMobileSidebar()` call.
 */
const renderSidebarState = ({ initiallyOpen = false }: { initiallyOpen?: boolean } = {}) => {
  const onOpenChange = mock()
  const onCloseComplete = mock()
  const onCloseCancel = mock()
  const hook = renderHook(
    () => {
      const [open, setOpen] = useState(initiallyOpen)
      const state = useMobileSidebarState({
        enabled: true,
        open,
        onOpenChange: (next) => {
          setOpen(next)
          onOpenChange(next)
        },
        onCloseComplete,
        onCloseCancel,
      })
      return { ...state, setOpen }
    },
    { wrapper: ({ children }: { children: ReactNode }) => <HapticsProvider>{children}</HapticsProvider> },
  )
  return { ...hook, onOpenChange, onCloseComplete, onCloseCancel }
}

describe('useMobileSidebarState drag lifecycle', () => {
  beforeEach(() => {
    useLocalSettingsStore.setState({ hapticsEnabled: true })
  })

  it('opens a closed sidebar once the drag passes the activation distance', () => {
    const { result, onOpenChange } = renderSidebarState()

    act(() => result.current.handleDragStart())
    act(() => {
      result.current.x.set(5) // below the 8px activation distance
      result.current.handleDrag()
    })
    expect(onOpenChange).not.toHaveBeenCalled()

    act(() => {
      result.current.x.set(12)
      result.current.handleDrag()
    })
    expect(onOpenChange).toHaveBeenCalledWith(true)

    // Continuing the same drag must not re-announce the open state.
    act(() => {
      result.current.x.set(80)
      result.current.handleDrag()
    })
    expect(onOpenChange).toHaveBeenCalledTimes(1)
  })

  it('resolves drag end to open and fires the haptic when the state changed', async () => {
    const { result, onOpenChange } = renderSidebarState()

    await act(async () => {
      result.current.handleDragStart()
      result.current.x.set(result.current.sidebarWidth)
      result.current.handleDragEnd(dragEndEvent(), makeDragInfo(0))
    })

    expect(onOpenChange).toHaveBeenCalledWith(true)
    expect(onOpenChange).toHaveBeenCalledTimes(1)
    expect(webHapticsTriggerMock).toHaveBeenCalledWith('light')
    expect(webHapticsTriggerMock).toHaveBeenCalledTimes(1)
  })

  it('stays silent when a drag ends back where it started', async () => {
    const { result, onOpenChange } = renderSidebarState()

    await act(async () => {
      result.current.handleDragStart()
      result.current.x.set(0)
      result.current.handleDragEnd(dragEndEvent(), makeDragInfo(0))
    })

    expect(onOpenChange).not.toHaveBeenCalled()
    expect(webHapticsTriggerMock).not.toHaveBeenCalled()
  })

  it('defers an external close arriving mid-drag and completes it at drag end', async () => {
    const { result, onCloseComplete } = renderSidebarState({ initiallyOpen: true })

    act(() => result.current.handleDragStart())
    // External closeMobileSidebar() while the finger is still down.
    act(() => result.current.setOpen(false))
    expect(onCloseComplete).not.toHaveBeenCalled()

    await act(async () => {
      result.current.x.set(0)
      result.current.handleDragEnd(dragEndEvent(), makeDragInfo(-600))
    })

    expect(onCloseComplete).toHaveBeenCalledTimes(1)
  })

  it('cancels a mid-drag external close when the drag settles open', async () => {
    const { result, onCloseComplete, onCloseCancel } = renderSidebarState({ initiallyOpen: true })

    act(() => result.current.handleDragStart())
    act(() => result.current.setOpen(false))

    await act(async () => {
      result.current.x.set(result.current.sidebarWidth)
      result.current.handleDragEnd(dragEndEvent(), makeDragInfo(600))
    })

    expect(onCloseCancel).toHaveBeenCalledTimes(1)
    expect(onCloseComplete).not.toHaveBeenCalled()
  })

  it('swallows only the ghost click that follows a drag', async () => {
    const { result, onOpenChange } = renderSidebarState()

    await act(async () => {
      result.current.handleDragStart()
      result.current.x.set(result.current.sidebarWidth)
      result.current.handleDrag()
      result.current.handleDragEnd(dragEndEvent(), makeDragInfo(600))
    })
    expect(onOpenChange).toHaveBeenCalledWith(true)

    // The browser-synthesized click right after pointerup must not close.
    act(() => result.current.handleCloseSurfaceClick())
    expect(onOpenChange).not.toHaveBeenCalledWith(false)

    // One frame later, a deliberate tap closes as usual.
    act(() => getClock().tick(20))
    act(() => result.current.handleCloseSurfaceClick())
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })
})
