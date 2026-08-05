/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { BrandGradientIcon } from '@/components/ui/brand-gradient-icon'

/**
 * Lucide's Check glyph drawn with the brand gradient stroke, with no enclosing
 * circle. Used where the success mark should stand alone.
 */
export const GradientCheck = ({ className }: { className?: string }) => (
  <BrandGradientIcon className={className}>
    {(stroke) => (
      /* Path data mirrors lucide-react's Check so the glyph stays identical. */
      <path d="M20 6 9 17l-5-5" stroke={stroke} />
    )}
  </BrandGradientIcon>
)
