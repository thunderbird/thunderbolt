/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { X } from 'lucide-react'
import type { ReactNode } from 'react'

import { SlideInPanel } from '@/components/slide-in-panel'
import { Button, mutedIconButtonClass } from '@/components/ui/button'
import { Dialog } from '@/components/ui/dialog'
import { floatingFormFooterClass } from '@/components/ui/form-footer'
import { panelFieldSurfaceClass } from '@/components/ui/modal-styles'
import {
  ResponsiveModalContentComposable,
  ResponsiveModalActions,
  ResponsiveModalPinnedHeader,
  useResponsiveModalContext,
} from '@/components/ui/responsive-modal'
import { useIsMobile } from '@/hooks/use-mobile'
import { cn } from '@/lib/utils'

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
export const DetailPanel = ({ icon, title, subtitle, actions, onClose, children }: DetailPanelProps) => {
  const { isMobile } = useResponsiveModalContext()

  return (
    // No bottom padding on mobile: the scroll container below carries the
    // safe-area / keyboard inset, so adding one here would double it and strand
    // the footer above the window edge.
    <section
      className="relative flex h-full flex-1 flex-col overflow-hidden px-4 text-foreground md:px-6 md:pb-5"
      style={isMobile ? { maxHeight: 'calc(100% - var(--kb, 0px))' } : undefined}
    >
      {/* Mobile pins the corner controls and the title bar between them — the
          title sits centered in the control row, freeing content space. */}
      {isMobile && actions && <ResponsiveModalActions>{actions}</ResponsiveModalActions>}
      {isMobile && <ResponsiveModalPinnedHeader title={title} subtitle={subtitle} />}

      {!isMobile && (
        // mt-2.5 brings the icon tile's top gap to 24px ((64 − 36) / 2 + 10),
        // matching the panel's md:px-6 left padding.
        <header className="relative mt-2.5 flex h-16 shrink-0 items-center justify-between gap-4">
          <div className="flex min-w-0 items-center gap-3">
            {icon}
            <div className="flex min-w-0 flex-col justify-center leading-tight">
              <h2 className="min-w-0 truncate text-xl leading-tight text-foreground">{title}</h2>
              {subtitle && <span className="truncate text-xs text-muted-foreground">{subtitle}</span>}
            </div>
          </div>
          {/* Pin the controls to the card's top-right corner, 8px from both
              edges (right: 24px padding − 16px; top: 8px − the header's 10px
              margin). Close sits outermost (the desktop convention); the
              mobile shell instead splits them across the top corners. */}
          <div className="absolute -right-4 -top-0.5 flex shrink-0 items-center gap-0.5">
            {actions}
            <Button
              variant="ghost"
              size="icon"
              onClick={onClose}
              aria-label="Close details"
              className={mutedIconButtonClass}
            >
              <X />
            </Button>
          </div>
        </header>
      )}

      {/* On mobile the panel frame ends at the keyboard boundary, giving this
          body a genuinely smaller scrollport. Bottom padding reserves the
          absolutely positioned action row; the generated keyboard-height
          spacer provides real scroll runway even when a short form otherwise
          fits and iOS has panned its focused field awkwardly. */}
      <div
        className={cn(
          "flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto md:pt-4 max-md:pt-[calc(var(--modal-top-inset)+1rem)] max-md:pb-[calc(var(--touch-height-default)+var(--modal-footer-inset))] max-md:after:h-[var(--kb,0px)] max-md:after:shrink-0 max-md:after:content-['']",
          floatingFormFooterClass,
        )}
      >
        {children}
      </div>
    </section>
  )
}

type DetailPanelSurfaceProps = {
  open: boolean
  onClose: () => void
  children: ReactNode
}

/**
 * The responsive surface the detail panels render into. Desktop: an inline
 * right-side slide-in at a ~50/50 split with the list (half the viewport
 * minus half the sidebar), on one continuous surface card lifted off the
 * page by the app's soft glow shadow plus a faint border — bg-sidebar
 * (near-white in light mode) like the chat composer. The header inset above
 * and bottom padding below float the card off the window edges by the same
 * 48px; callers leave the outer
 * flex row unclipped so the glow can extend beyond that inset naturally. Its
 * right edge stays flush and square with only the left corners rounded. Mobile
 * uses the same full-screen fade/scale modal as other responsive views.
 */
export const DetailPanelSurface = ({ open, onClose, children }: DetailPanelSurfaceProps) => {
  const { isMobile } = useIsMobile()

  if (!isMobile) {
    return (
      // The warm 6% glow is invisible on the dark background (same rationale
      // as the .dark elevation overrides in index.css), so dark mode swaps in
      // a slightly stronger black ink at the same blur radius.
      <SlideInPanel
        open={open}
        width="clamp(440px, calc(50vw - 128px), 520px)"
        className="[filter:drop-shadow(var(--shadow-glow-strong))] dark:[filter:drop-shadow(0_0_32px_rgb(0_0_0/24%))]"
      >
        <div className="h-full pb-12">
          <div
            className={cn(
              'h-full overflow-hidden rounded-l-2xl border border-r-0 border-border/60 bg-sidebar',
              panelFieldSurfaceClass,
            )}
          >
            {children}
          </div>
        </div>
      </SlideInPanel>
    )
  }
  return (
    <Dialog open={open} onOpenChange={(nextOpen) => !nextOpen && onClose()}>
      <ResponsiveModalContentComposable className="gap-0 p-0" flush>
        {children}
      </ResponsiveModalContentComposable>
    </Dialog>
  )
}
