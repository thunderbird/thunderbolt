/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { ReactNode } from 'react'

import { SlideInPanel } from '@/components/slide-in-panel'
import { Dialog } from '@/components/ui/dialog'
import { panelFieldSurfaceClass } from '@/components/ui/modal-styles'
import { ResponsiveModalContentComposable } from '@/components/ui/responsive-modal'
import { useIsMobile } from '@/hooks/use-mobile'
import { cn } from '@/lib/utils'

type CreateItemSurfaceProps = {
  open: boolean
  onClose: () => void
  children: ReactNode
}

/**
 * Route-independent create surface. Mobile uses the shared full-screen modal;
 * desktop pushes the current route when space permits and overlays it below
 * the layout's content-width floor.
 */
export const CreateItemSurface = ({ open, onClose, children }: CreateItemSurfaceProps) => {
  const { isMobile } = useIsMobile()

  if (isMobile) {
    return (
      <Dialog open={open} onOpenChange={(nextOpen) => !nextOpen && onClose()}>
        <ResponsiveModalContentComposable className="gap-0 p-0" flush>
          {children}
        </ResponsiveModalContentComposable>
      </Dialog>
    )
  }

  return (
    <SlideInPanel
      open={open}
      width="clamp(440px, calc(50vw - 128px), 520px)"
      className="[filter:drop-shadow(var(--shadow-glow-strong))] dark:[filter:drop-shadow(0_0_32px_rgb(0_0_0/24%))]"
    >
      <div className="h-full pb-12 pt-12">
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
