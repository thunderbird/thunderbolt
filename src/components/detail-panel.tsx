/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { AnimatePresence, m } from 'framer-motion'
import { X } from 'lucide-react'
import type { ReactNode } from 'react'

import { SlideInPanel } from '@/components/slide-in-panel'
import { Button, mutedIconButtonClass } from '@/components/ui/button'

/**
 * Shared anatomy for the slide-in detail panels (skills, agents, CLI): one
 * scrollable column with a fixed header — title block left, actions pinned
 * top-right — so the panels read as one system.
 */

/** Uppercase hairline section heading. Children beyond text (e.g. an info
 *  tooltip) lay out inline via the flex row. */
export const DetailSectionTitle = ({ children }: { children: ReactNode }) => (
  <h3 className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
    {children}
  </h3>
)

/** Hairline divider between detail sections (transparent-on-surface idiom). */
export const DetailDivider = () => <div className="h-px shrink-0 bg-border/60" />

type DetailPanelProps = {
  /** Optional leading icon tile rendered beside the title. */
  icon?: ReactNode
  title: string
  /** Optional provenance/subtitle line under the title. */
  subtitle?: string
  /** Extra header actions (e.g. a ⋯ menu), rendered left of the Close button. */
  actions?: ReactNode
  onClose: () => void
  children: ReactNode
}

/**
 * The panel frame: header (title block + actions + Close) above a scrollable
 * body. Deliberately transparent — on desktop it sits inside the slide-in
 * surface card, on mobile inside the full-screen overlay — so content lies
 * flat on the surface with hairline dividers instead of nested cards.
 */
export const DetailPanel = ({ icon, title, subtitle, actions, onClose, children }: DetailPanelProps) => (
  <section className="flex h-full flex-1 flex-col overflow-hidden px-4 pb-5 text-foreground md:px-6">
    {/* Mobile keeps the list's title-row height (shared page chrome); the
        desktop card gets a taller header so the title has room to breathe. */}
    <header className="relative flex h-[var(--touch-height-xl)] shrink-0 items-center justify-between gap-4 md:h-16">
      <div className="flex min-w-0 items-center gap-3">
        {icon}
        <div className="flex min-w-0 flex-col justify-center leading-tight">
          <h2 className="min-w-0 truncate text-xl leading-tight text-foreground">{title}</h2>
          {subtitle && <span className="truncate text-xs text-muted-foreground">{subtitle}</span>}
        </div>
      </div>
      {/* Desktop: pin the actions to the card's top-right corner, 8px from
          both edges (right: 24px padding − 16px), independent of the taller
          header so the X stays equidistant from top and right. */}
      <div className="flex shrink-0 items-center gap-0.5 md:absolute md:-right-4 md:top-2">
        {actions}
        <Button
          variant="ghost"
          size="icon"
          onClick={onClose}
          aria-label="Close details"
          className={mutedIconButtonClass}
        >
          <X className="size-4" />
        </Button>
      </div>
    </header>

    {/* The whole body scrolls as one area. */}
    <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto pt-4">{children}</div>
  </section>
)

type DetailPanelSurfaceProps = {
  open: boolean
  isMobile: boolean
  children: ReactNode
}

/**
 * The responsive surface the detail panels render into. Desktop: an inline
 * right-side slide-in at a ~50/50 split with the list (half the viewport
 * minus half the sidebar), on one continuous surface card lifted off the
 * page by the app's soft glow shadow plus a faint border — bg-sidebar
 * (near-white in light mode) like the chat composer, bottom padding floating
 * the card off the window edge, right edge flush and square with only the
 * left corners rounded. Mobile: a full-screen spring slide-over.
 */
export const DetailPanelSurface = ({ open, isMobile, children }: DetailPanelSurfaceProps) => {
  if (!isMobile) {
    return (
      <SlideInPanel open={open} width="clamp(400px, calc(50vw - 128px), 800px)">
        <div className="h-full pb-4">
          <div className="h-full overflow-hidden rounded-l-2xl border border-r-0 border-border/60 bg-sidebar shadow-glow">
            {children}
          </div>
        </div>
      </SlideInPanel>
    )
  }
  return (
    <AnimatePresence>
      {open && (
        <m.div
          key="mobile-detail-panel"
          className="absolute inset-0 z-10 flex bg-background"
          initial={{ x: '100%' }}
          animate={{ x: 0 }}
          exit={{ x: '100%' }}
          transition={{ type: 'spring', damping: 35, stiffness: 400, mass: 0.8 }}
        >
          {children}
        </m.div>
      )}
    </AnimatePresence>
  )
}
