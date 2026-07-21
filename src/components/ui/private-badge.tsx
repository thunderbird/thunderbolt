/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { GradientLock } from '@/components/ui/gradient-lock'
import { cn } from '@/lib/utils'

/**
 * Confidential-model indicator: gradient lock + "Private" in one continuous
 * amber→raspberry sweep. The wrapper carries the gradient and clips it to the text
 * (which sits on the right, so the glyphs sample the pink end), while the
 * lock's SVG gradient is stretched to the same total width (~52px = 89
 * viewBox units at the 14px icon size) so it samples only the gold lead-in.
 * Used in the model selector dropdown and the models settings page.
 */
export const PrivateBadge = ({ className }: { className?: string }) => (
  <span className={cn('flex items-center gap-1 bg-clip-text [background-image:var(--gradient-brand)]', className)}>
    <GradientLock className="size-3.5" gradientEndX={89} />
    <span className="text-transparent text-[length:var(--font-size-xs)] font-medium">Private</span>
  </span>
)
