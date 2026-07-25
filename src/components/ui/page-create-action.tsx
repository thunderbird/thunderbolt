/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Plus } from 'lucide-react'
import { createPortal } from 'react-dom'

import { Button } from '@/components/ui/button'
import { useMobileForegroundPortalTarget } from '@/components/ui/mobile-foreground-portal'
import { useIsMobile, useIsNativeMobile } from '@/hooks/use-mobile'
import { edgeSpacing } from '@/lib/constants'

type PageCreateActionProps = {
  /** Doubles as the mobile pill's visible text and the desktop button's accessible name. */
  label: string
  onClick: () => void
  disabled?: boolean
}

/**
 * A list page's primary create action, rendered where each viewport expects
 * it: a compact outline "+" beside the page title on desktop, a floating
 * brand-gradient pill in the bottom-right corner on mobile.
 *
 * The pill mirrors the sidebar footer's mobile New Chat button — same height,
 * radius, and gradient — so every "make a new thing" control in the app reads
 * as the same control. It is the only gradient button a page may show; empty
 * states pair with it using `variant="outline"`.
 *
 * Portaled to the mobile foreground shell so it stays viewport-anchored while
 * moving with that shell when navigation is revealed.
 */
export const PageCreateAction = ({ label, onClick, disabled }: PageCreateActionProps) => {
  const { isMobile } = useIsMobile()
  const isNativeMobile = useIsNativeMobile()
  const portalTarget = useMobileForegroundPortalTarget()

  if (!isMobile) {
    return (
      <Button
        variant="ghost"
        size="icon"
        // PageHeader pulls general actions in by 8px to align with row controls.
        // The primary create action instead aligns its outer edge with the
        // content surface itself, so compensate for that shared inset.
        // Ghost + bg-card: a filled, borderless tile (borders removed from the
        // settings create actions by design).
        className="-mr-2 bg-card hover:bg-accent"
        aria-label={label}
        onClick={onClick}
        disabled={disabled}
      >
        <Plus />
      </Button>
    )
  }

  if (!portalTarget) {
    return null
  }

  return createPortal(
    <Button
      size="lg"
      // Sits below the z-50 modal layer: opening a detail panel should bury
      // the pill under the overlay, not float it above. Native mobile's sidebar
      // removes its own footer padding and sits directly on the safe-area inset;
      // web mobile retains the footer's 8px padding. Mirroring that distinction
      // keeps this pill aligned with New Chat in both environments.
      // border-none: the New Chat pill this mirrors is borderless.
      className="fixed right-4 z-30 rounded-full border-none shadow-lg"
      style={{
        bottom: isNativeMobile
          ? `max(var(--safe-area-bottom-padding), ${edgeSpacing.mobile}px)`
          : 'calc(var(--safe-area-bottom-padding, 0px) + 0.5rem)',
      }}
      onClick={onClick}
      disabled={disabled}
    >
      <Plus className="size-[var(--icon-size-default)]" />
      {label}
    </Button>,
    portalTarget,
  )
}
