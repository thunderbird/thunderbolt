/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * A project's icon: its chosen emoji, or the folder glyph when it has none.
 *
 * One component so the list row, the sidebar drop row, the detail title and the
 * drag preview can't drift — an emoji needs different vertical centring from a
 * lucide glyph, and getting that wrong in one place is the kind of thing nobody
 * notices until it ships.
 */

import { FolderOpen } from 'lucide-react'

import { cn } from '@/lib/utils'

type ProjectIconProps = {
  icon: string | null | undefined
  /** Tailwind size utility for the fallback glyph (emoji scales via font-size). */
  className?: string
}

export const ProjectIcon = ({ icon, className }: ProjectIconProps) => {
  if (!icon) {
    return <FolderOpen className={cn('text-muted-foreground', className ?? 'size-5')} aria-hidden="true" />
  }
  // `leading-none` + a flex box: emoji carry their own ascent/descent, so
  // ordinary line-height pushes them off-centre inside a fixed-size row.
  return (
    <span
      aria-hidden="true"
      className={cn('flex items-center justify-center leading-none', className ?? 'text-[1.1rem]')}
    >
      {icon}
    </span>
  )
}
